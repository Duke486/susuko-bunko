#!/usr/bin/env node
// スス子文庫（Susuko Bunko）同步服务端 —— 零依赖，Node.js 18+ 即可运行
//   SHIORI_KEY=你的访问密钥 node server.js
// 环境变量：SHIORI_KEY（必填）、PORT（默认 8787）、HOST（默认 127.0.0.1）、DATA_DIR（默认 ./data）
'use strict';
const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '127.0.0.1';
const KEY = process.env.SHIORI_KEY || '';
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
const APP_DIR = path.resolve(process.env.APP_DIR || path.join(__dirname, '..', 'app'));
const MAX_BOOK_BYTES = Number(process.env.MAX_BOOK_MB || 2048) * 1024 * 1024;
const VERSION = '0.2.0';

if (!KEY || KEY.length < 8) {
  console.error('请先设置访问密钥（至少 8 位）：SHIORI_KEY=xxxxxxxx node server.js');
  process.exit(1);
}

const BOOKS_DIR = path.join(DATA_DIR, 'books');
const COVERS_DIR = path.join(DATA_DIR, 'covers');
const DB_FILE = path.join(DATA_DIR, 'db.json');
for (const d of [DATA_DIR, BOOKS_DIR, COVERS_DIR]) fs.mkdirSync(d, { recursive: true });

// ---------- 数据库（一个 JSON 文件，原子写入） ----------
let db = { books: {}, collections: {}, progress: {} };
if (fs.existsSync(DB_FILE)) {
  db = Object.assign(db, JSON.parse(fs.readFileSync(DB_FILE, 'utf8')));
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

function authed(req) {
  const h = req.headers.authorization || '';
  const got = Buffer.from(h.startsWith('Bearer ') ? h.slice(7) : '');
  const want = Buffer.from(KEY);
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}
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
async function readJson(req) {
  const buf = await readBody(req);
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

// ---------- API ----------
const bookFile = (b) => path.join(BOOKS_DIR, `${b.id}.${b.format}`);
const coverFile = (id) => path.join(COVERS_DIR, `${id}.jpg`);

async function uploadBook(req, res, q) {
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
  const dup = Object.values(db.books).find((b) => b.sha256 === sha);
  if (dup) { await fsp.rm(tmp, { force: true }); return json(res, 200, { book: dup, duplicate: true }); }

  const now = Date.now();
  const cols = (q.get('collections') || '').split(',').filter((c) => db.collections[c]);
  const book = {
    id, format, size, sha256: sha,
    title: str(q.get('title')) || str(q.get('name')) || '未命名',
    author: str(q.get('author')),
    series: str(q.get('series'), 200), volume: volumeOf(q.get('volume')),
    fileName: str(q.get('name')),
    collections: cols, hasCover: false, addedAt: now, updatedAt: now,
  };
  await fsp.rename(tmp, bookFile(book));
  db.books[id] = book; save();
  json(res, 201, { book });
}

async function api(req, res, url) {
  const seg = url.pathname.split('/').filter(Boolean).slice(1); // 去掉 "api"
  const M = req.method;
  const q = url.searchParams;

  if (seg[0] === 'ping' && M === 'GET') return json(res, 200, { ok: true, name: 'susuko-bunko', version: VERSION });
  if (seg[0] === 'state' && M === 'GET') return json(res, 200, { ...db, serverTime: Date.now() });

  if (seg[0] === 'books') {
    if (seg.length === 1 && M === 'POST') return uploadBook(req, res, q);
    const book = isId(seg[1] || '') ? db.books[seg[1]] : null;
    if (!book) return fail(res, 404, '没有这本书');

    if (seg.length === 2 && M === 'PATCH') {
      const body = await readJson(req);
      if (typeof body.title === 'string' && str(body.title)) book.title = str(body.title);
      if (typeof body.author === 'string') book.author = str(body.author);
      if (typeof body.series === 'string') book.series = str(body.series, 200);
      if ('volume' in body) book.volume = volumeOf(body.volume);
      if (!book.series) book.volume = null;
      if (Array.isArray(body.collections)) book.collections = [...new Set(body.collections.filter((c) => db.collections[c]))];
      book.updatedAt = Date.now(); save();
      return json(res, 200, { book });
    }
    if (seg.length === 2 && M === 'DELETE') {
      delete db.books[book.id]; delete db.progress[book.id]; save();
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
      const order = Object.values(db.collections).reduce((m, c) => Math.max(m, c.order), 0) + 1;
      const col = { id: newId(), name, order, createdAt: now, updatedAt: now };
      db.collections[col.id] = col; save();
      return json(res, 201, { collection: col });
    }
    const col = isId(seg[1] || '') ? db.collections[seg[1]] : null;
    if (!col) return fail(res, 404, '没有这个合集');
    if (M === 'PATCH') {
      const body = await readJson(req);
      if (typeof body.name === 'string' && str(body.name, 60)) col.name = str(body.name, 60);
      if (Number.isFinite(body.order)) col.order = body.order;
      col.updatedAt = Date.now(); save();
      return json(res, 200, { collection: col });
    }
    if (M === 'DELETE') { // 只删合集，不删书
      delete db.collections[col.id];
      for (const b of Object.values(db.books)) {
        if (b.collections.includes(col.id)) { b.collections = b.collections.filter((c) => c !== col.id); b.updatedAt = Date.now(); }
      }
      save();
      return json(res, 200, { ok: true });
    }
  }

  if (seg[0] === 'progress' && seg.length === 2 && M === 'PUT') {
    if (!db.books[seg[1]]) return fail(res, 404, '没有这本书');
    const body = await readJson(req);
    const incoming = {
      loc: body.loc && typeof body.loc === 'object' ? body.loc : {},
      percent: Math.min(1, Math.max(0, Number(body.percent) || 0)),
      updatedAt: Math.min(Number(body.updatedAt) || Date.now(), Date.now() + 60000),
      device: str(body.device, 40),
    };
    if (JSON.stringify(incoming.loc).length > 2000) return fail(res, 400, '进度数据过大');
    const cur = db.progress[seg[1]];
    if (!cur || incoming.updatedAt >= cur.updatedAt) { db.progress[seg[1]] = incoming; save(); } // 以最新时间为准
    return json(res, 200, { progress: db.progress[seg[1]] });
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
    if (url.pathname.startsWith('/api/')) {
      if (!authed(req)) return fail(res, 401, '访问密钥不正确');
      return await api(req, res, url);
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') return fail(res, 405, '不支持的方法');
    serveStatic(req, res, url);
  } catch (e) {
    if (!e.code) console.error(e);
    if (!res.headersSent) fail(res, typeof e.code === 'number' ? e.code : 500, e.message || '服务器出错');
    else res.destroy();
  }
}).listen(PORT, HOST, () => {
  console.log(`スス子文庫 服务端已启动：http://${HOST}:${PORT}  数据目录：${DATA_DIR}`);
});
