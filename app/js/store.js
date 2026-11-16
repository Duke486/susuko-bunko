// 数据层：服务器 API、本地缓存（IndexedDB）、进度同步。
import { ZipReader, mimeOf, isImageName } from './zip.js';
import { Epub } from './epub.js';

// ---------- 本机设置 ----------
const LS = 'shiori.';
export const prefs = {
  get(key, fallback) {
    try { const v = localStorage.getItem(LS + key); return v == null ? fallback : JSON.parse(v); } catch { return fallback; }
  },
  set(key, value) { try { localStorage.setItem(LS + key, JSON.stringify(value)); } catch { /* 存不下就算了 */ } },
  remove(key) { try { localStorage.removeItem(LS + key); } catch { /* 忽略 */ } },
};

export const isNativeShell = location.protocol === 'tauri:' || location.hostname === 'tauri.localhost';

function defaultDeviceName() {
  const ua = navigator.userAgent;
  if (/Android/i.test(ua)) return '安卓设备';
  if (/Windows/i.test(ua)) return 'Windows 电脑';
  if (/Mac/i.test(ua)) return 'Mac';
  return '浏览器';
}
export const deviceName = () => prefs.get('device', '') || defaultDeviceName();

// ---------- IndexedDB ----------
let dbPromise = null;
function idb() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open('shiori', 1);
      req.onupgradeneeded = () => {
        for (const name of ['files', 'covers', 'kv']) req.result.createObjectStore(name);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}
async function tx(store, mode, fn) {
  const db = await idb();
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const req = fn(t.objectStore(store));
    t.oncomplete = () => resolve(req && req.result);
    t.onerror = t.onabort = () => reject(t.error || new Error('本地存储失败'));
  });
}
const local = {
  get: (store, key) => tx(store, 'readonly', (s) => s.get(key)),
  put: (store, key, value) => tx(store, 'readwrite', (s) => s.put(value, key)),
  del: (store, key) => tx(store, 'readwrite', (s) => s.delete(key)),
  keys: (store) => tx(store, 'readonly', (s) => s.getAllKeys()),
  clear: (store) => tx(store, 'readwrite', (s) => s.clear()),
};

// ---------- 状态 ----------
export const state = {
  books: {}, collections: {}, progress: {},
  downloaded: new Set(), // 已缓存到本机的书
  online: false, syncing: false, lastSync: 0,
};
let pending = {}; // 还没推到服务器的进度
const listeners = new Set();
export const onChange = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };
let emitQueued = false;
function emit() {
  if (emitQueued) return;
  emitQueued = true;
  queueMicrotask(() => { emitQueued = false; for (const fn of listeners) fn(); });
}

const persist = () => local.put('kv', 'state', { books: state.books, collections: state.collections, progress: state.progress }).catch(() => {});
const persistPending = () => local.put('kv', 'pending', pending).catch(() => {});

export function server() { return prefs.get('server', null); } // { url, key }
export const isConfigured = () => !!server();

// ---------- API ----------
export class ApiError extends Error {
  constructor(message, status) { super(message); this.status = status; }
}
async function api(path, opts = {}, conf = server()) {
  if (!conf) throw new ApiError('还没有连接服务器', 0);
  let res;
  try {
    res = await fetch(conf.url + path, {
      ...opts, headers: { Authorization: 'Bearer ' + conf.key, ...(opts.headers || {}) },
    });
  } catch {
    throw new ApiError('连不上服务器，请检查网络或服务器地址', 0);
  }
  if (!res.ok) {
    let message = `服务器返回 ${res.status}`;
    try { message = (await res.json()).error || message; } catch { /* 非 JSON */ }
    throw new ApiError(message, res.status);
  }
  return res;
}
const apiJson = async (path, method, body) => (await api(path, {
  method, headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
  body: body === undefined ? undefined : JSON.stringify(body),
})).json();

export async function connect(url, key) {
  url = url.trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
  const conf = { url, key: key.trim() };
  const res = await (await api('/api/ping', {}, conf)).json();
  if (res.name !== 'susuko-bunko' && res.name !== 'shiori') throw new ApiError('这个地址不是スス子文庫的同步服务', 0);
  prefs.set('server', conf);
  await sync();
}

export async function disconnect() {
  prefs.remove('server');
  await Promise.all(['files', 'covers', 'kv'].map((s) => local.clear(s)));
  Object.assign(state, { books: {}, collections: {}, progress: {}, downloaded: new Set(), online: false });
  pending = {};
  for (const u of coverUrls.values()) URL.revokeObjectURL(u);
  coverUrls.clear();
  emit();
}

export async function init() {
  try {
    const [cached, pend, keys] = await Promise.all([local.get('kv', 'state'), local.get('kv', 'pending'), local.keys('files')]);
    if (cached) Object.assign(state, cached);
    pending = pend || {};
    for (const [id, p] of Object.entries(pending)) state.progress[id] = p;
    state.downloaded = new Set(keys);
  } catch { /* 本地存储不可用时只能在线使用 */ }
  emit();
}

// ---------- 同步 ----------
let syncRunning = null;
export function sync() {
  if (!isConfigured()) return Promise.resolve();
  if (!syncRunning) syncRunning = doSync().finally(() => { syncRunning = null; });
  return syncRunning;
}
async function doSync() {
  state.syncing = true; emit();
  try {
    await flushProgress();
    const remote = await (await api('/api/state')).json();
    state.books = remote.books; state.collections = remote.collections;
    const progress = remote.progress;
    for (const [id, p] of Object.entries(pending)) { // 本地更新的进度不被旧数据覆盖
      if (!progress[id] || p.updatedAt > progress[id].updatedAt) progress[id] = p;
    }
    state.progress = progress;
    state.online = true; state.lastSync = Date.now();
    await persist();
    // 服务器上已删除的书，清掉本地缓存
    for (const id of [...state.downloaded]) {
      if (!state.books[id]) { state.downloaded.delete(id); local.del('files', id).catch(() => {}); }
    }
  } catch (e) {
    state.online = false;
    throw e;
  } finally {
    state.syncing = false; emit();
  }
}

async function flushProgress() {
  for (const [id, p] of Object.entries(pending)) {
    try {
      const res = await apiJson('/api/progress/' + id, 'PUT', p);
      if (pending[id] === p) delete pending[id];
      if (res.progress.updatedAt > p.updatedAt) state.progress[id] = res.progress;
    } catch (e) {
      if (e.status === 404) { delete pending[id]; continue; }
      throw e;
    }
  }
  await persistPending();
}

let flushTimer = null;
export function setProgress(bookId, loc, percent) {
  const p = { loc, percent, updatedAt: Date.now(), device: deviceName() };
  state.progress[bookId] = p;
  pending[bookId] = p;
  persistPending(); persist();
  clearTimeout(flushTimer);
  flushTimer = setTimeout(() => flushProgress().then(() => { state.online = true; }, () => { state.online = false; }), 2500);
}
export function flushNow() {
  clearTimeout(flushTimer);
  if (!Object.keys(pending).length) return Promise.resolve();
  return flushProgress().catch(() => {});
}
document.addEventListener('visibilitychange', () => { if (document.hidden) flushNow(); });

/** 打开书之前拉一次这本书在别的设备上的最新进度 */
export async function freshProgress(bookId) {
  try { await sync(); } catch { /* 离线就用本地的 */ }
  return state.progress[bookId] || null;
}

// ---------- 封面 ----------
const coverUrls = new Map();
export async function coverUrl(book) {
  if (!book.hasCover) return null;
  const key = `${book.id}:${book.coverAt || 0}`;
  if (coverUrls.has(key)) return coverUrls.get(key);
  const job = (async () => {
    let cached = await local.get('covers', book.id).catch(() => null);
    if (!cached || cached.at !== (book.coverAt || 0)) {
      const blob = await (await api(`/api/books/${book.id}/cover`)).blob();
      cached = { at: book.coverAt || 0, blob };
      local.put('covers', book.id, cached).catch(() => {});
    }
    return URL.createObjectURL(cached.blob);
  })();
  coverUrls.set(key, job);
  job.catch(() => coverUrls.delete(key));
  return job;
}

async function shrinkCover(blob) {
  const bmp = await createImageBitmap(blob);
  const scale = Math.min(1, 600 / bmp.width);
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bmp.width * scale); canvas.height = Math.round(bmp.height * scale);
  canvas.getContext('2d').drawImage(bmp, 0, 0, canvas.width, canvas.height);
  bmp.close?.();
  return new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.85));
}

// ---------- 书籍文件 ----------
// 没下载的书不用等整本下完：按 512KB 的小块向服务器要正在读的那部分（HTTP Range），
// 空闲时再在后台把剩下的块补齐，补齐后存进本机，之后离线也能读。
const CHUNK = 512 * 1024;
class RemoteSource {
  constructor(book) {
    this.book = book; this.size = book.size;
    this.count = Math.ceil(book.size / CHUNK);
    this.chunks = new Map(); this.inflight = new Map();
    this.demand = 0; this.filling = false; this.saved = false;
    this.watchers = new Set();
  }
  get progress() { return this.chunks.size / this.count; }

  async _fetchRun(first, last) {
    const from = first * CHUNK, to = Math.min((last + 1) * CHUNK, this.size) - 1;
    const res = await api(`/api/books/${this.book.id}/file`, { headers: { Range: `bytes=${from}-${to}` } });
    const buf = new Uint8Array(await res.arrayBuffer());
    const base = res.status === 206 ? first : 0; // 服务器若不支持分段，会直接给整本
    for (let off = 0, i = base; off < buf.length; off += CHUNK, i++) this.chunks.set(i, buf.subarray(off, off + CHUNK));
    for (const fn of this.watchers) fn(this.progress);
    if (this.chunks.size >= this.count) this._save();
  }
  _ensure(first, last) {
    const jobs = [];
    let run = null;
    const flush = () => {
      if (!run) return;
      const [a, z] = run; run = null;
      const job = this._fetchRun(a, z).finally(() => { for (let i = a; i <= z; i++) this.inflight.delete(i); });
      for (let i = a; i <= z; i++) this.inflight.set(i, job);
    };
    for (let i = first; i <= last; i++) {
      if (this.chunks.has(i) || this.inflight.has(i)) { flush(); continue; }
      if (run) run[1] = i; else run = [i, i];
    }
    flush();
    for (let i = first; i <= last; i++) if (this.inflight.has(i)) jobs.push(this.inflight.get(i));
    return Promise.all(jobs);
  }
  async read(start, end) {
    start = Math.max(0, start); end = Math.min(this.size, end);
    if (end <= start) return new ArrayBuffer(0);
    const first = Math.floor(start / CHUNK), last = Math.floor((end - 1) / CHUNK);
    this.demand++;
    try { await this._ensure(first, last); } finally { this.demand--; }
    const out = new Uint8Array(end - start);
    for (let i = first; i <= last; i++) {
      const chunk = this.chunks.get(i);
      if (!chunk) throw new ApiError('这部分内容没有加载出来，请检查网络', 0);
      const cs = i * CHUNK, a = Math.max(start, cs), z = Math.min(end, cs + chunk.length);
      out.set(chunk.subarray(a - cs, z - cs), a - start);
    }
    return out.buffer;
  }
  /** 后台补齐整本。正在读的内容优先，补齐让路。 */
  async fill() {
    if (this.filling || this.saved) return;
    this.filling = true;
    let failures = 0;
    try {
      while (this.filling && this.chunks.size < this.count) {
        if (this.demand > 0) { await sleep(200); continue; }
        let next = 0;
        while (this.chunks.has(next) || this.inflight.has(next)) next++;
        if (next >= this.count) { await sleep(200); continue; }
        try { await this._ensure(next, next); failures = 0; }
        catch (e) { if (++failures >= 5) throw e; await sleep(3000); }
      }
    } finally { this.filling = false; }
  }
  pause() { this.filling = false; }
  _save() {
    if (!this.saving) {
      this.saved = true;
      this.saving = (async () => {
        const blob = new Blob(Array.from({ length: this.count }, (_, i) => this.chunks.get(i)));
        try { await local.put('files', this.book.id, blob); state.downloaded.add(this.book.id); emit(); }
        catch { /* 空间不够时仍可在线阅读 */ }
      })();
    }
    return this.saving;
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const remotes = new Map(); // 最近打开的在线书，保留已加载的块
function remoteOf(book) {
  let src = remotes.get(book.id);
  if (!src) {
    src = new RemoteSource(book);
    remotes.set(book.id, src);
    for (const [id, old] of remotes) { // 只留最近两本，其余释放内存
      if (remotes.size <= 2) break;
      if (id !== book.id && !old.filling) remotes.delete(id);
    }
  }
  return src;
}

/** 打开一本书用的数据源：本机有就用本机的，否则边读边从服务器取 */
export async function bookSource(book) {
  const cached = await local.get('files', book.id).catch(() => null);
  if (cached) return { source: cached, release() {} };
  const src = remoteOf(book);
  if (prefs.get('autoCache', true)) src.fill().catch(() => {});
  return { source: src, release() { src.pause(); } };
}

/** 把整本书下载到本机（离线阅读用） */
export async function downloadBook(book, onProgress) {
  if (state.downloaded.has(book.id)) return;
  const src = remoteOf(book);
  const watch = (p) => onProgress?.(p);
  src.watchers.add(watch);
  try {
    while (src.chunks.size < src.count) {
      if (src.filling) await sleep(300); else await src.fill();
    }
    await src._save();
    if (!state.downloaded.has(book.id)) throw new ApiError('本机空间不够，没能保存', 0);
  } finally { src.watchers.delete(watch); remotes.delete(book.id); }
}

export async function removeLocalCopy(bookId) {
  remotes.delete(bookId);
  await local.del('files', bookId);
  state.downloaded.delete(bookId); emit();
}

/** 阅读状态：手动设过就用手动的，否则按进度判断 */
export function statusOf(book) {
  if (book.status === 'reading' || book.status === 'finished') return book.status;
  const p = state.progress[book.id]?.percent || 0;
  return p >= 0.995 ? 'finished' : p > 0 ? 'reading' : 'unread';
}

export function natural(a, b) {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
}

/** 从书名里猜系列和卷号："某某 第3卷" / "某某 03" / "某某 (3)" / "某某 Vol.3" */
export function guessSeries(title) {
  const m = /^(.*?)[\s　_\-—~～:：]*(?:第\s*(\d{1,4}(?:\.\d)?)\s*[卷巻册冊集部]|vol(?:ume)?[.\s]*(\d{1,4}(?:\.\d)?)|[(（\[【](\d{1,3}(?:\.\d)?)[)）\]】]|(?<!\d)(\d{1,3}(?:\.\d)?))\s*$/i.exec(title.trim());
  if (!m) return null;
  const series = m[1].trim();
  const volume = parseFloat(m[2] ?? m[3] ?? m[4] ?? m[5]);
  if (series.length < 2 || !Number.isFinite(volume)) return null;
  return { series, volume };
}
export const seriesLabel = (book) => (book.series ? `${book.series}${book.volume != null ? ` ${book.volume}` : ''}` : book.title);

async function inspect(file) {
  const name = file.name.replace(/\.[^.]+$/, '');
  const ext = file.name.slice(file.name.lastIndexOf('.') + 1).toLowerCase();
  if (ext === 'epub') {
    const epub = await Epub.open(file);
    const cover = await epub.coverBlob().catch(() => null);
    const title = epub.title || name;
    const guess = epub.series ? { series: epub.series, volume: epub.volume } : guessSeries(title);
    return { format: 'epub', title, author: epub.author, illustrator: epub.illustrator, cover, ...guess };
  }
  if (ext === 'cbz' || ext === 'zip') {
    const zip = await ZipReader.open(file);
    const pages = zip.entries.filter((e) => !e.isDir && isImageName(e.name)).sort((a, b) => natural(a.name, b.name));
    if (!pages.length) throw new Error('压缩包里没有找到图片');
    return { format: 'cbz', title: name, author: '', cover: await zip.blobOf(pages[0], mimeOf(pages[0].name)), ...guessSeries(name) };
  }
  throw new Error('只支持 EPUB 和 CBZ / ZIP');
}

/** 导入一本书：本地解析书名与封面 → 上传到服务器 → 留一份在本机 */
export async function importBook(file, collectionIds = []) {
  const info = await inspect(file);
  const q = new URLSearchParams({
    format: info.format, title: info.title, author: info.author, name: file.name, collections: collectionIds.join(','),
    series: info.series || '', volume: info.volume ?? '', illustrator: info.illustrator || '',
  });
  const { book, duplicate } = await (await api('/api/books?' + q, { method: 'POST', body: file })).json();
  let saved = book;
  if (!duplicate && info.cover) {
    try {
      const jpg = await shrinkCover(info.cover);
      saved = (await (await api(`/api/books/${book.id}/cover`, { method: 'PUT', body: jpg })).json()).book;
      local.put('covers', book.id, { at: saved.coverAt, blob: jpg }).catch(() => {});
    } catch { /* 封面失败不影响书 */ }
  }
  state.books[saved.id] = saved;
  try { await local.put('files', saved.id, file.slice()); state.downloaded.add(saved.id); } catch { /* 忽略 */ }
  persist(); emit();
  return { book: saved, duplicate: !!duplicate };
}

export async function updateBook(id, patch) {
  const { book } = await apiJson('/api/books/' + id, 'PATCH', patch);
  state.books[id] = book; persist(); emit();
}
export async function deleteBook(id) {
  await apiJson('/api/books/' + id, 'DELETE');
  delete state.books[id]; delete state.progress[id]; delete pending[id];
  state.downloaded.delete(id);
  local.del('files', id).catch(() => {}); local.del('covers', id).catch(() => {});
  persist(); emit();
}

// ---------- 合集 ----------
export async function createCollection(name) {
  const { collection } = await apiJson('/api/collections', 'POST', { name });
  state.collections[collection.id] = collection; persist(); emit();
  return collection;
}
export async function renameCollection(id, name) {
  const { collection } = await apiJson('/api/collections/' + id, 'PATCH', { name });
  state.collections[id] = collection; persist(); emit();
}
export async function deleteCollection(id) {
  await apiJson('/api/collections/' + id, 'DELETE');
  delete state.collections[id];
  for (const b of Object.values(state.books)) b.collections = b.collections.filter((c) => c !== id);
  persist(); emit();
}
export const sortedCollections = () => Object.values(state.collections).sort((a, b) => a.order - b.order);

export async function localUsage() {
  try { const e = await navigator.storage.estimate(); return e.usage || 0; } catch { return 0; }
}
