#!/usr/bin/env node
// スス子文庫（Susuko Bunko）同步服务端 —— 零依赖，Node.js 18+ 即可运行
//   SHIORI_KEY=你的邀请码 node server.js
// 环境变量：
//   SHIORI_KEY   必填。注册账号时要填的邀请码（防止陌生人注册）；旧版客户端也可以直接用它登录第一个账号
//   PORT         默认 8787        HOST      默认 127.0.0.1
//   DATA_DIR     默认 ./data      MAX_BOOK_MB 单本上限，默认 2048
//   OPEN_SIGNUP  设为 1 时注册不需要邀请码
'use strict';
const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { Readable } = require('node:stream');

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '127.0.0.1';
const KEY = process.env.SHIORI_KEY || '';
const OPEN_SIGNUP = process.env.OPEN_SIGNUP === '1';
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
const APP_DIR = path.resolve(process.env.APP_DIR || path.join(__dirname, '..', 'app'));
const MAX_BOOK_BYTES = Number(process.env.MAX_BOOK_MB || 2048) * 1024 * 1024;
const VERSION = '0.8.1';

if (!KEY || KEY.length < 8) {
  console.error('请先设置邀请码（至少 8 位）：SHIORI_KEY=xxxxxxxx node server.js');
  process.exit(1);
}

const BOOKS_DIR = path.join(DATA_DIR, 'books');
const COVERS_DIR = path.join(DATA_DIR, 'covers');
const AVATARS_DIR = path.join(DATA_DIR, 'avatars');
const DB_FILE = path.join(DATA_DIR, 'db.json');
for (const d of [DATA_DIR, BOOKS_DIR, COVERS_DIR, AVATARS_DIR]) fs.mkdirSync(d, { recursive: true });

// ---------- 数据库（一个 JSON 文件，原子写入） ----------
// 结构：{ version: 2, users: { uid: 用户 }, tokens: { 令牌哈希: { uid } }, libs: { uid: 书库 }, legacy?: 旧版单人书库 }
const emptyLib = () => ({ books: {}, collections: {}, progress: {}, marks: {}, stats: {}, hours: {}, series: {}, settings: null });
let db = { version: 2, users: {}, tokens: {}, libs: {} };
if (fs.existsSync(DB_FILE)) {
  const raw = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  if (raw.version === 2) db = Object.assign(db, raw);
  else { // 0.4 及以前：整个文件就是一个人的书库，留给第一个注册的账号
    db.legacy = Object.assign(emptyLib(), raw);
    console.log('检测到旧版书库，第一个注册的账号会自动接管它');
  }
}
let saveTimer = null, saving = Promise.resolve();
function save() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    saving = saving.then(flush).catch((e) => console.error('保存失败', e));
  }, 200);
}
async function flush() {
  const tmp = DB_FILE + '.tmp';
  await fsp.writeFile(tmp, JSON.stringify(db));
  await fsp.rename(tmp, DB_FILE);
}
function shutdown() {
  if (saveTimer) { clearTimeout(saveTimer); fs.writeFileSync(DB_FILE, JSON.stringify(db)); }
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// ---------- 工具 ----------
const newId = () => crypto.randomBytes(8).toString('hex');
const isId = (s) => /^[a-f0-9]{16}$/.test(s);
const FORMATS = new Set(['epub', 'cbz']);
const MARK_TYPES = new Set(['bookmark', 'note', 'highlight']);
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const safeEqual = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization,Content-Type,Range');
  res.setHeader('Access-Control-Expose-Headers', 'Content-Range,Content-Length,Accept-Ranges');
  res.setHeader('Access-Control-Max-Age', '86400');
}
function json(res, code, body) {
  const s = JSON.stringify(body);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(s);
}
const fail = (res, code, message) => json(res, code, { error: message });

function readBody(req, limit = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []; let n = 0;
    req.on('data', (c) => {
      n += c.length;
      if (n > limit) { reject(Object.assign(new Error('请求体过大'), { code: 413 })); req.destroy(); }
      else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
async function readJson(req, limit) {
  const buf = await readBody(req, limit);
  try { return JSON.parse(buf.toString('utf8') || '{}'); }
  catch { throw Object.assign(new Error('JSON 格式错误'), { code: 400 }); }
}
const str = (v, max = 500) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
function volumeOf(v) { // 卷号：允许 7.5 这样的番外卷；空值表示没有卷号
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 && n < 100000 ? n : null;
}

function sendFile(req, res, file, type, downloadName) {
  fs.stat(file, (err, st) => {
    if (err) return fail(res, 404, '文件不存在');
    const headers = { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Cache-Control': 'private, max-age=0' };
    if (downloadName) headers['Content-Disposition'] = `attachment; filename*=UTF-8''${encodeURIComponent(downloadName)}`;
    let start = 0, end = st.size - 1, code = 200;
    const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
    if (m && (m[1] || m[2])) {
      if (m[1]) { start = Number(m[1]); if (m[2]) end = Math.min(end, Number(m[2])); }
      else start = Math.max(0, st.size - Number(m[2]));
      if (start > end || start >= st.size) {
        res.writeHead(416, { 'Content-Range': `bytes */${st.size}` }); return res.end();
      }
      code = 206; headers['Content-Range'] = `bytes ${start}-${end}/${st.size}`;
    }
    headers['Content-Length'] = end - start + 1;
    res.writeHead(code, headers);
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file, { start, end }).pipe(res);
  });
}

// ---------- 账号 ----------
const hashPassword = (password, salt) => crypto.scryptSync(password, salt, 64).toString('hex');
const publicUser = (u) => ({ id: u.id, username: u.username, nickname: u.nickname, avatarAt: u.avatarAt || 0, createdAt: u.createdAt });
function issueToken(uid, device) {
  const token = crypto.randomBytes(24).toString('base64url');
  db.tokens[sha256(token)] = { uid, device: str(device, 40), createdAt: Date.now() };
  save();
  return token;
}
/** 从请求头找出是哪个账号。旧版客户端发来的 SHIORI_KEY 视为第一个账号。 */
function userOf(req) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : '';
  if (!token) return null;
  const t = db.tokens[sha256(token)];
  if (t && db.users[t.uid]) return db.users[t.uid];
  if (safeEqual(token, KEY)) return Object.values(db.users).sort((a, b) => a.createdAt - b.createdAt)[0] || null;
  return null;
}
// 登录失败太多次就暂时拒绝（按 IP）
const failures = new Map();
function tooMany(ip) {
  const f = failures.get(ip);
  return f && f.count >= 8 && Date.now() - f.at < 10 * 60 * 1000;
}
function noteFailure(ip) {
  const f = failures.get(ip);
  if (f && Date.now() - f.at < 10 * 60 * 1000) f.count++; else failures.set(ip, { count: 1, at: Date.now() });
}

async function auth(req, res, seg) {
  const ip = req.socket.remoteAddress;
  if (seg[1] === 'register' && req.method === 'POST') {
    const body = await readJson(req);
    if (tooMany(ip)) return fail(res, 429, '尝试太多次了，请十分钟后再试');
    if (!OPEN_SIGNUP && !safeEqual(str(body.invite, 200), KEY)) { noteFailure(ip); return fail(res, 403, '邀请码不对。邀请码就是启动服务端时设置的 SHIORI_KEY'); }
    const username = str(body.username, 32).toLowerCase();
    if (!/^[a-z0-9_.\-぀-ヿ一-鿿]{2,32}$/.test(username)) return fail(res, 400, '用户名需要 2～32 个字符，可以用字母、数字、中文、日文和 _ . -');
    if (typeof body.password !== 'string' || body.password.length < 6) return fail(res, 400, '密码至少 6 位');
    if (Object.values(db.users).some((u) => u.username === username)) return fail(res, 409, '这个用户名已经有人用了');
    const salt = crypto.randomBytes(16).toString('hex');
    const user = {
      id: newId(), username, nickname: str(body.nickname, 40) || username,
      salt, hash: hashPassword(body.password, salt), avatarAt: 0, createdAt: Date.now(),
    };
    db.users[user.id] = user;
    db.libs[user.id] = db.legacy || emptyLib(); // 第一个账号接管旧版书库
    delete db.legacy;
    save();
    return json(res, 201, { token: issueToken(user.id, body.device), user: publicUser(user) });
  }
  if (seg[1] === 'login' && req.method === 'POST') {
    const body = await readJson(req);
    if (tooMany(ip)) return fail(res, 429, '尝试太多次了，请十分钟后再试');
    const user = Object.values(db.users).find((u) => u.username === str(body.username, 32).toLowerCase());
    if (!user || typeof body.password !== 'string' || !safeEqual(hashPassword(body.password, user.salt), user.hash)) {
      noteFailure(ip);
      return fail(res, 401, '用户名或密码不对');
    }
    failures.delete(ip);
    return json(res, 200, { token: issueToken(user.id, body.device), user: publicUser(user) });
  }
  if (seg[1] === 'logout' && req.method === 'POST') {
    const h = req.headers.authorization || '';
    delete db.tokens[sha256(h.startsWith('Bearer ') ? h.slice(7) : '')];
    save();
    return json(res, 200, { ok: true });
  }
  fail(res, 404, '接口不存在');
}

// ---------- 书库 API（都在当前账号的书库里操作） ----------
const bookFile = (b) => path.join(BOOKS_DIR, `${b.id}.${b.format}`);
const coverFile = (id) => path.join(COVERS_DIR, `${id}.jpg`);
const avatarFile = (uid) => path.join(AVATARS_DIR, `${uid}.jpg`);

async function uploadBook(req, res, q, lib) {
  const format = str(q.get('format'), 8).toLowerCase();
  if (!FORMATS.has(format)) return fail(res, 400, '只支持 epub 和 cbz/zip');
  const declared = Number(req.headers['content-length'] || 0);
  if (declared > MAX_BOOK_BYTES) return fail(res, 413, '文件超过大小上限');

  const id = newId();
  const tmp = path.join(BOOKS_DIR, `${id}.part`);
  const hash = crypto.createHash('sha256');
  let size = 0;
  try {
    await new Promise((resolve, reject) => {
      const out = fs.createWriteStream(tmp);
      req.on('data', (c) => {
        size += c.length; hash.update(c);
        if (size > MAX_BOOK_BYTES) { req.destroy(); reject(Object.assign(new Error('文件超过大小上限'), { code: 413 })); }
      });
      req.on('aborted', () => reject(new Error('上传中断')));
      req.on('error', reject); out.on('error', reject); out.on('finish', resolve);
      req.pipe(out);
    });
  } catch (e) {
    await fsp.rm(tmp, { force: true });
    return fail(res, e.code === 413 ? 413 : 400, e.message);
  }
  if (!size) { await fsp.rm(tmp, { force: true }); return fail(res, 400, '空文件'); }

  const sha = hash.digest('hex');
  const dup = Object.values(lib.books).find((b) => b.sha256 === sha);
  if (dup) { await fsp.rm(tmp, { force: true }); return json(res, 200, { book: dup, duplicate: true }); }

  const now = Date.now();
  const cols = (q.get('collections') || '').split(',').filter((c) => lib.collections[c]);
  const book = {
    id, format, size, sha256: sha,
    title: str(q.get('title')) || str(q.get('name')) || '未命名',
    author: str(q.get('author')),
    illustrator: str(q.get('illustrator'), 200), publisher: str(q.get('publisher'), 200), status: '',
    rating: 0, review: '', description: '',
    series: str(q.get('series'), 200), volume: volumeOf(q.get('volume')),
    fileName: str(q.get('name')),
    collections: cols, hasCover: false, addedAt: Number(q.get('addedAt')) || now, updatedAt: now,
  };
  await fsp.rename(tmp, bookFile(book));
  lib.books[id] = book; save();
  json(res, 201, { book });
}

// 出版时间：只收 2024 / 2024-07 / 2024-07-18 这三种写法
const dateOf = (v) => (/^\d{4}(-\d{2}(-\d{2})?)?$/.test(String(v).trim()) ? String(v).trim() : '');
function patchBook(book, body, lib) {
  if (typeof body.title === 'string' && str(body.title)) book.title = str(body.title);
  if (typeof body.author === 'string') book.author = str(body.author);
  if (typeof body.illustrator === 'string') book.illustrator = str(body.illustrator, 200);
  if (typeof body.publisher === 'string') book.publisher = str(body.publisher, 200);
  if (typeof body.description === 'string') book.description = str(body.description, 8000);
  if (Number.isInteger(body.rating) && body.rating >= 0 && body.rating <= 5) book.rating = body.rating; // 0 = 没评分
  if (typeof body.review === 'string') book.review = str(body.review, 5000);
  if (['', 'reading', 'finished'].includes(body.status)) book.status = body.status; // 空 = 按进度自动判断
  if (typeof body.series === 'string') book.series = str(body.series, 200);
  if (typeof body.imprint === 'string') book.imprint = str(body.imprint, 40);
  if (typeof body.published === 'string') book.published = dateOf(body.published);
  if (typeof body.spineFace === 'string') book.spineFace = /^(none|[01](\.\d{1,3})?,[01](\.\d{1,3})?)?$/.test(body.spineFace) ? body.spineFace : '';
  if ('volume' in body) book.volume = volumeOf(body.volume);
  if (!book.series) book.volume = null;
  if (Array.isArray(body.collections)) book.collections = [...new Set(body.collections.filter((c) => lib.collections[c]))];
  book.updatedAt = Date.now();
}

/** 把 AI 请求转发到用户自己配置的接口（避开浏览器的跨域限制），原样流式返回 */
async function aiProxy(req, res) {
  const body = await readJson(req, 2 * 1024 * 1024);
  let target;
  try { target = new URL(body.url); } catch { return fail(res, 400, '接口地址格式不对'); }
  if (!/^https?:$/.test(target.protocol)) return fail(res, 400, '接口地址必须是 http 或 https');
  const ctrl = new AbortController();
  req.on('close', () => ctrl.abort());
  let upstream;
  try {
    upstream = await fetch(target, {
      method: 'POST', signal: ctrl.signal,
      headers: { 'Content-Type': 'application/json', ...(body.key ? { Authorization: 'Bearer ' + body.key } : {}) },
      body: JSON.stringify(body.payload ?? {}),
    });
  } catch (e) {
    return fail(res, 502, `服务器连不上这个接口：${e.message}`);
  }
  res.writeHead(upstream.status, {
    'Content-Type': upstream.headers.get('content-type') || 'application/octet-stream', 'Cache-Control': 'no-store',
  });
  if (!upstream.body) return res.end();
  Readable.fromWeb(upstream.body).on('error', () => res.destroy()).pipe(res);
}

async function api(req, res, url) {
  const seg = url.pathname.split('/').filter(Boolean).slice(1); // 去掉 "api"
  const M = req.method;
  const q = url.searchParams;

  if (seg[0] === 'ping' && M === 'GET') {
    return json(res, 200, { ok: true, name: 'susuko-bunko', version: VERSION, accounts: true, users: Object.keys(db.users).length, openSignup: OPEN_SIGNUP });
  }
  if (seg[0] === 'auth') return auth(req, res, seg);

  const user = userOf(req);
  if (!user) return fail(res, 401, '登录已失效，请重新登录');
  const lib = db.libs[user.id] || (db.libs[user.id] = emptyLib());
  for (const [k, v] of Object.entries(emptyLib())) if (!(k in lib)) lib[k] = v; // 旧书库补上新字段

  if (seg[0] === 'me') {
    if (seg.length === 1 && M === 'GET') return json(res, 200, { user: publicUser(user) });
    if (seg.length === 1 && M === 'PATCH') {
      const body = await readJson(req);
      if (typeof body.nickname === 'string' && str(body.nickname, 40)) user.nickname = str(body.nickname, 40);
      if (body.newPassword !== undefined) {
        if (typeof body.oldPassword !== 'string' || !safeEqual(hashPassword(body.oldPassword, user.salt), user.hash)) return fail(res, 403, '原密码不对');
        if (typeof body.newPassword !== 'string' || body.newPassword.length < 6) return fail(res, 400, '新密码至少 6 位');
        user.salt = crypto.randomBytes(16).toString('hex');
        user.hash = hashPassword(body.newPassword, user.salt);
      }
      save();
      return json(res, 200, { user: publicUser(user) });
    }
    // 账号设置（阅读器排版、主题色、阅读助手接口等）：整份覆盖，以较新的为准
    if (seg[1] === 'settings' && M === 'GET') return json(res, 200, { settings: lib.settings });
    if (seg[1] === 'settings' && M === 'PUT') {
      const body = await readJson(req, 256 * 1024);
      if (!body.data || typeof body.data !== 'object') return fail(res, 400, '设置格式不对');
      const updatedAt = Math.min(Number(body.updatedAt) || Date.now(), Date.now() + 60000);
      if (!lib.settings || updatedAt >= lib.settings.updatedAt) { lib.settings = { data: body.data, updatedAt }; save(); }
      return json(res, 200, { settings: lib.settings });
    }
    if (seg[1] === 'avatar' && (M === 'GET' || M === 'HEAD')) return sendFile(req, res, avatarFile(user.id), 'image/jpeg');
    if (seg[1] === 'avatar' && M === 'PUT') {
      const buf = await readBody(req, 2 * 1024 * 1024);
      if (!buf.length) return fail(res, 400, '空图片');
      await fsp.writeFile(avatarFile(user.id), buf);
      user.avatarAt = Date.now(); save();
      return json(res, 200, { user: publicUser(user) });
    }
  }

  if (seg[0] === 'state' && M === 'GET') return json(res, 200, { ...lib, user: publicUser(user), serverTime: Date.now() });
  if (seg[0] === 'ai' && M === 'POST') return aiProxy(req, res);

  if (seg[0] === 'books') {
    if (seg.length === 1 && M === 'POST') return uploadBook(req, res, q, lib);
    const book = isId(seg[1] || '') ? lib.books[seg[1]] : null;
    if (!book) return fail(res, 404, '没有这本书');

    if (seg.length === 2 && M === 'PATCH') {
      patchBook(book, await readJson(req), lib); save();
      return json(res, 200, { book });
    }
    if (seg.length === 2 && M === 'DELETE') {
      delete lib.books[book.id]; delete lib.progress[book.id]; delete lib.marks[book.id]; save();
      await fsp.rm(bookFile(book), { force: true });
      await fsp.rm(coverFile(book.id), { force: true });
      return json(res, 200, { ok: true });
    }
    if (seg[2] === 'file' && (M === 'GET' || M === 'HEAD')) {
      return sendFile(req, res, bookFile(book), 'application/octet-stream', book.fileName || `${book.title}.${book.format}`);
    }
    if (seg[2] === 'cover' && (M === 'GET' || M === 'HEAD')) return sendFile(req, res, coverFile(book.id), 'image/jpeg');
    if (seg[2] === 'cover' && M === 'PUT') {
      const buf = await readBody(req, 4 * 1024 * 1024);
      if (!buf.length) return fail(res, 400, '空封面');
      await fsp.writeFile(coverFile(book.id), buf);
      book.hasCover = true; book.coverAt = Date.now(); book.updatedAt = Date.now(); save();
      return json(res, 200, { book });
    }
  }

  if (seg[0] === 'collections') {
    if (seg.length === 1 && M === 'POST') {
      const body = await readJson(req);
      const name = str(body.name, 60);
      if (!name) return fail(res, 400, '合集需要一个名字');
      const now = Date.now();
      const order = Object.values(lib.collections).reduce((m, c) => Math.max(m, c.order), 0) + 1;
      const col = { id: newId(), name, order, createdAt: now, updatedAt: now };
      lib.collections[col.id] = col; save();
      return json(res, 201, { collection: col });
    }
    const col = isId(seg[1] || '') ? lib.collections[seg[1]] : null;
    if (!col) return fail(res, 404, '没有这个合集');
    if (M === 'PATCH') {
      const body = await readJson(req);
      if (typeof body.name === 'string' && str(body.name, 60)) col.name = str(body.name, 60);
      if (Number.isFinite(body.order)) col.order = body.order;
      col.updatedAt = Date.now(); save();
      return json(res, 200, { collection: col });
    }
    if (M === 'DELETE') { // 只删合集，不删书
      delete lib.collections[col.id];
      for (const b of Object.values(lib.books)) {
        if (b.collections.includes(col.id)) { b.collections = b.collections.filter((c) => c !== col.id); b.updatedAt = Date.now(); }
      }
      save();
      return json(res, 200, { ok: true });
    }
  }

  if (seg[0] === 'progress' && seg.length === 2 && M === 'PUT') {
    if (!lib.books[seg[1]]) return fail(res, 404, '没有这本书');
    const body = await readJson(req);
    const incoming = {
      loc: body.loc && typeof body.loc === 'object' ? body.loc : {},
      percent: Math.min(1, Math.max(0, Number(body.percent) || 0)),
      updatedAt: Math.min(Number(body.updatedAt) || Date.now(), Date.now() + 60000),
      device: str(body.device, 40),
    };
    if (JSON.stringify(incoming.loc).length > 2000) return fail(res, 400, '进度数据过大');
    const cur = lib.progress[seg[1]];
    if (!cur || incoming.updatedAt >= cur.updatedAt) { lib.progress[seg[1]] = incoming; save(); } // 以最新时间为准
    return json(res, 200, { progress: lib.progress[seg[1]] });
  }

  // 书签、页笔记、划线批注：每条由客户端生成 id，整条覆盖写入
  if (seg[0] === 'marks' && seg.length === 3 && /^[a-f0-9]{8,32}$/.test(seg[2])) {
    if (!lib.books[seg[1]]) return fail(res, 404, '没有这本书');
    const list = lib.marks[seg[1]] || (lib.marks[seg[1]] = {});
    if (M === 'PUT') {
      const body = await readJson(req);
      const mark = {
        id: seg[2], type: MARK_TYPES.has(body.type) ? body.type : 'bookmark',
        loc: body.loc && typeof body.loc === 'object' ? body.loc : {},
        percent: Math.min(1, Math.max(0, Number(body.percent) || 0)),
        chapter: str(body.chapter, 200), excerpt: str(body.excerpt, 2000), text: str(body.text, 5000),
        color: str(body.color, 16),
        createdAt: Number(body.createdAt) || Date.now(), updatedAt: Date.now(),
      };
      if (JSON.stringify(mark.loc).length > 2000) return fail(res, 400, '位置数据过大');
      if (!list[mark.id] && Object.keys(list).length >= 5000) return fail(res, 400, '这本书的记号太多了');
      list[mark.id] = mark; save();
      return json(res, 200, { mark });
    }
    if (M === 'DELETE') { delete list[seg[2]]; save(); return json(res, 200, { ok: true }); }
  }

  // 系列简介
  if (seg[0] === 'series' && seg.length === 1 && M === 'PUT') {
    const body = await readJson(req);
    const name = str(body.name, 200);
    if (!name) return fail(res, 400, '缺少系列名');
    if (str(body.description, 8000)) lib.series[name] = { description: str(body.description, 8000), updatedAt: Date.now() };
    else delete lib.series[name];
    save();
    return json(res, 200, { series: lib.series[name] || null });
  }

  // 阅读时长：客户端上报增量，服务器按“日期 → 书”累加，多台设备不会互相覆盖
  if (seg[0] === 'stats' && seg.length === 1 && M === 'POST') {
    const body = await readJson(req);
    for (const it of Array.isArray(body.add) ? body.add.slice(0, 2000) : []) {
      const seconds = Math.round(Number(it.seconds));
      if (!/^\d{4}-\d{2}-\d{2}$/.test(it.day) || !lib.books[it.book] || !(seconds > 0) || seconds > 86400) continue;
      const day = lib.stats[it.day] || (lib.stats[it.day] = {});
      day[it.book] = Math.min(86400, (day[it.book] || 0) + seconds);
      if (Number.isInteger(it.hour) && it.hour >= 0 && it.hour < 24) { // 一天里几点在读，统计页的节律图用
        const hrs = lib.hours[it.day] || (lib.hours[it.day] = {});
        hrs[it.hour] = Math.min(3600, (hrs[it.hour] || 0) + seconds);
      }
    }
    save();
    return json(res, 200, { ok: true });
  }

  fail(res, 404, '接口不存在');
}

// ---------- 静态文件（网页版客户端） ----------
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
};
function serveStatic(req, res, url) {
  let rel;
  try { rel = decodeURIComponent(url.pathname); } catch { return fail(res, 400, '路径错误'); }
  if (rel.endsWith('/')) rel += 'index.html';
  const file = path.join(APP_DIR, rel);
  if (file !== APP_DIR && !file.startsWith(APP_DIR + path.sep)) return fail(res, 403, '禁止访问');
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('404'); }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'Content-Length': st.size, 'Cache-Control': 'no-cache',
    });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).pipe(res);
  });
}

http.createServer(async (req, res) => {
  cors(res);
  let url;
  try { url = new URL(req.url, 'http://x'); } catch { return fail(res, 400, '地址错误'); }
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
  try {
    if (url.pathname.startsWith('/api/')) return await api(req, res, url);
    if (req.method !== 'GET' && req.method !== 'HEAD') return fail(res, 405, '不支持的方法');
    serveStatic(req, res, url);
  } catch (e) {
    if (!e.code) console.error(e);
    if (!res.headersSent) fail(res, typeof e.code === 'number' ? e.code : 500, e.message || '服务器出错');
    else res.destroy();
  }
}).listen(PORT, HOST, () => {
  console.log(`スス子文庫 服务端 ${VERSION} 已启动：http://${HOST}:${PORT}  数据目录：${DATA_DIR}`);
});
