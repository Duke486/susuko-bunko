// 百度网盘“设备直连”：安卓 / Windows 客户端用原生网络层直接从百度下载，网页版继续经服务器转发。
//
// 流程：向自己的服务器要短时效的 CDN 地址（服务器保证里面不含百度令牌）→ 原生命令按 Range 读取。
// 直连出任何问题（地址过期、百度按 IP 拒绝、网络错误、Range 对不上）都自动退回服务器转发。
// 这些地址只放在内存里：不写本地存储、不打日志、不出现在提示文字里。
// 向自己服务器发请求的函数由 store.js 注入（避免两个模块互相导入）
let apiJson = null;
export function useApi(fn) { apiJson = fn; }

const invoke = () => window.__TAURI__?.core?.invoke;
export const nativeAvailable = () => typeof invoke() === 'function';

const urls = new Map(); // `${bookId}:${key}` → { url, exp }
const pending = new Map(); // 同一批地址只要一次
const offUntil = new Map(); // bookId → 时间：直连失败后这段时间里先走转发，避免每次都等失败
const routes = new Map(); // bookId → 'direct' | 'proxy' | 'local'
const stats = new Map(); // bookId → { direct, proxy, fallbacks, lastError }
const OFF_FOR = 10 * 60 * 1000;

export const ROUTE_TEXT = { direct: '设备直连百度网盘', proxy: '经服务器转发', local: '本机缓存' };

/** 记录这本书实际是从哪条路读出来的，阅读器上的小标签会跟着变 */
export function setRoute(bookId, route) {
  const s = stats.get(bookId) || { direct: 0, proxy: 0, fallbacks: 0, lastError: '' };
  if (route === 'direct' || route === 'proxy') s[route]++;
  stats.set(bookId, s);
  if (routes.get(bookId) === route) return;
  routes.set(bookId, route);
  window.dispatchEvent(new CustomEvent('read-route', { detail: { bookId, route } }));
}
export const routeOf = (bookId) => routes.get(bookId) || '';
export const routeStats = (bookId) => ({ direct: 0, proxy: 0, fallbacks: 0, lastError: '', ...(stats.get(bookId) || {}) });

export function directEnabled(book) {
  if (!nativeAvailable() || !book?.source) return false;
  if (book.source.type !== 'baidu' && book.source.type !== 'baidu-dir') return false;
  return (offUntil.get(book.id) || 0) < Date.now();
}
function noteFailure(book, code) {
  offUntil.set(book.id, Date.now() + OFF_FOR);
  const s = stats.get(book.id) || { direct: 0, proxy: 0, fallbacks: 0, lastError: '' };
  s.fallbacks++; s.lastError = code;
  stats.set(book.id, s);
}

async function fetchUrls(book, keys) {
  const body = { bookId: book.id };
  if (book.source.type === 'baidu-dir') body.pages = keys.map(Number);
  const { items } = await apiJson('/api/cloud/baidu/direct', 'POST', body);
  for (const it of items) if (it.url) urls.set(`${book.id}:${it.key}`, { url: it.url, exp: Date.now() + (it.ttl || 600000) - 30000 });
  return items;
}
async function urlFor(book, key, fresh = false, ahead = []) {
  const id = `${book.id}:${key}`;
  const hit = urls.get(id);
  if (!fresh && hit && hit.exp > Date.now()) return hit.url;
  if (!pending.has(id)) {
    // 图片文件夹：顺便把后面几页的地址一起要来，翻页时不用再等服务器
    const keys = [key, ...ahead.filter((k) => { const h = urls.get(`${book.id}:${k}`); return !h || h.exp < Date.now(); })].slice(0, 12);
    const job = fetchUrls(book, keys).finally(() => { for (const k of keys) pending.delete(`${book.id}:${k}`); });
    for (const k of keys) pending.set(`${book.id}:${k}`, job);
  }
  const items = await pending.get(id);
  const mine = items?.find((x) => x.key === String(key));
  if (mine && !mine.url) throw Object.assign(new Error(mine.error || 'failed'), { code: mine.error || 'failed' });
  const got = urls.get(id);
  if (!got) throw Object.assign(new Error('failed'), { code: 'failed' });
  return got.url;
}
async function nativeRange(url, start, end) {
  const buf = await invoke()('cloud_range', { url, start, end });
  return new Uint8Array(buf instanceof ArrayBuffer ? buf : buf.buffer || buf);
}

/**
 * 直连读取一段字节。成功返回 Uint8Array；失败返回 null（调用方接着走服务器转发）。
 * key：整本文件用 'file'，图片文件夹用页码。
 */
export async function directRead(book, key, start, end, ahead = [], fileSize = Infinity) {
  if (!directEnabled(book)) return null;
  for (let attempt = 0; attempt < 2; attempt++) {
    let url;
    try { url = await urlFor(book, key, attempt > 0, ahead); }
    catch (e) { noteFailure(book, `server:${e.code || 'failed'}`); return null; }
    try {
      // 一次最多取 4MB，大段拆开取（原生命令单次上限 16MB）
      const want = Math.min(end, fileSize - 1) - start + 1;
      const out = new Uint8Array(want);
      for (let off = 0; off < want;) {
        const a = start + off, z = Math.min(start + want - 1, a + 4 * 1024 * 1024 - 1);
        const part = await nativeRange(url, a, z);
        if (part.length !== z - a + 1) throw new Error('range'); // 中间少了字节就不能用
        out.set(part, off); off += part.length;
      }
      setRoute(book.id, 'direct');
      return out;
    } catch (e) {
      const code = String(e?.message || e);
      // 地址过期或被拒绝：重新要一次地址再试；其他错误直接回退
      if (attempt === 0 && /^status:(403|401|404|410)/.test(code)) { urls.delete(`${book.id}:${key}`); continue; }
      noteFailure(book, code.slice(0, 40));
      return null;
    }
  }
  noteFailure(book, 'status:403');
  return null;
}

/**
 * 诊断：在真实网络上检查直连能不能用，并和服务器转发逐段核对内容。
 * 返回统计数字，不包含任何地址。
 */
export async function diagnose(book, { rounds = 12, chunk = 256 * 1024, proxyRead } = {}) {
  const out = { native: nativeAvailable(), ok: 0, fail: 0, mismatch: 0, errors: {}, directMs: [], proxyMs: [] };
  if (!out.native) return out;
  offUntil.delete(book.id);
  const size = book.size;
  const isDir = book.source.type === 'baidu-dir';
  for (let i = 0; i < rounds; i++) {
    // 随机跳到任意位置读一段；第一轮固定读开头，最后一轮读结尾
    const key = isDir ? String(Math.floor(Math.random() * Math.max(1, book.source.count || 1))) : 'file';
    const total = isDir ? null : size;
    let start = 0, end = chunk - 1;
    if (total) {
      start = i === 0 ? 0 : i === rounds - 1 ? Math.max(0, total - chunk) : Math.floor(Math.random() * Math.max(1, total - chunk));
      end = Math.min(total - 1, start + chunk - 1);
    }
    let a = null;
    const t0 = performance.now();
    try {
      const url = await urlFor(book, key, i === 0);
      a = await nativeRange(url, start, end);
      out.directMs.push(Math.round(performance.now() - t0));
    } catch (e) {
      const code = String(e?.code || e?.message || e).slice(0, 40);
      out.errors[code] = (out.errors[code] || 0) + 1; out.fail++;
      continue;
    }
    const t1 = performance.now();
    const b = await proxyRead(key, start, start + a.length - 1).catch(() => null);
    out.proxyMs.push(Math.round(performance.now() - t1));
    if (!b || b.length !== a.length || !a.every((v, k) => v === b[k])) out.mismatch++;
    else out.ok++;
  }
  return out;
}

/** 阅读器顶部的小标签：显示这本书实际是从哪里读出来的（直连 / 转发 / 本机），中途回退也会跟着变 */
export function routeChip(book) {
  if (!book?.source) return null;
  const el = document.createElement('span');
  el.className = 'route-chip';
  el.setAttribute('role', 'status');
  const draw = () => {
    const r = routeOf(book.id);
    el.dataset.route = r || 'wait';
    el.textContent = r ? ROUTE_TEXT[r] : nativeAvailable() ? '正在连接网盘…' : '经服务器转发';
    const s = stats.get(book.id);
    el.title = r === 'proxy' && s?.fallbacks ? '设备直连没成功，已自动改走服务器转发（十分钟后会再试直连）' : '';
  };
  const on = (e) => { if (!el.isConnected && e) { window.removeEventListener('read-route', on); return; } if (!e || e.detail.bookId === book.id) draw(); };
  window.addEventListener('read-route', on);
  draw();
  return el;
}
