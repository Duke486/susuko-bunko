// 在线书库：Novelia（轻小说机翻机器人，n.novelia.cc）。
// 浏览器直接请求那边会被跨域拦下，所以由自己的服务器转发。
// 列表、详情、下载都不强制登录；登录（可选）后能看到更多分级。账号令牌只存在服务器，不下发到客户端。
//
// 接口参考开源项目 auto-novel/auto-novel 的前端代码（只是按同样的地址调用，没有拷贝代码）：
//   GET  /api/wenku?page&pageSize&query&level                 文库小说列表
//   GET  /api/wenku/{id}                                       文库小说详情（含 volumeJp：可下载的日文卷及各家翻译进度）
//   GET  /api/wenku/{id}/file/{volumeId}?mode&translationsMode&translations&filename   生成并下载 EPUB（302 到临时文件）
//   GET  /api/novel?page&pageSize&query&provider&type&level&translate&sort             网络小说列表
//   GET  /api/novel/{provider}/{id}                            网络小说详情（含目录）
//   GET  /api/novel/{provider}/{id}/file?mode&translationsMode&type&filename&translations  下载整本 EPUB
//   POST https://auth.novelia.cc/api/v1/auth/login {username,password,app:'n'} → 正文是令牌，Set-Cookie 里是 refresh-token
//   POST https://auth.novelia.cc/api/v1/auth/refresh?app=n （带 refresh-token cookie）→ 新令牌
'use strict';

const API = (process.env.NOVELIA_API || 'https://n.novelia.cc').replace(/\/+$/, '');
const AUTH = (process.env.NOVELIA_AUTH || 'https://auth.novelia.cc').replace(/\/+$/, '');
const UA = 'susuko-bunko/0.12 (self-hosted personal reader)';
const TRANSLATORS = ['sakura', 'gpt', 'youdao', 'baidu'];
const PROVIDERS = 'kakuyomu,syosetu,novelup,hameln,pixiv,alphapolis';

const cache = new Map(); // 列表和详情缓存 5 分钟，翻页来回看不用重复请求
const CACHE_MS = 5 * 60 * 1000;
function cached(key) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.data;
  cache.delete(key);
  return null;
}
function remember(key, data) {
  cache.set(key, { at: Date.now(), data });
  if (cache.size > 300) cache.delete(cache.keys().next().value);
}

const err = (status, message) => Object.assign(new Error(message), { status });

function cookieOf(res) {
  const all = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [res.headers.get('set-cookie') || ''];
  for (const c of all) for (const part of String(c).split(/,(?=\s*refresh-token=)/)) {
    const m = /(?:^|\s)(refresh-token=[^;]*)/.exec(part);
    if (m) return m[1];
  }
  return '';
}

async function login(account, username, password) {
  const res = await fetch(`${AUTH}/api/v1/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'User-Agent': UA },
    body: JSON.stringify({ username, password, app: 'n' }), signal: AbortSignal.timeout(20000),
  });
  const text = (await res.text()).trim();
  if (!res.ok) throw err(res.status === 401 || res.status === 400 ? 400 : 502, res.status === 401 || res.status === 400 ? '用户名或密码不对' : `登录失败（${res.status}）`);
  if (!text || text.length > 4000 || text.startsWith('{')) throw err(502, '登录返回的内容看不懂，可能 Novelia 改了接口');
  account.token = text;
  account.refresh = cookieOf(res) || account.refresh || '';
  account.username = username;
  account.at = Date.now();
}

async function refresh(account) {
  if (!account.refresh) return false;
  const res = await fetch(`${AUTH}/api/v1/auth/refresh?app=n`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: account.refresh, 'User-Agent': UA },
    body: '', signal: AbortSignal.timeout(20000),
  }).catch(() => null);
  if (!res) return false;
  if (res.status === 401) { account.token = ''; account.refresh = ''; return false; }
  const text = (await res.text()).trim();
  if (!res.ok || !text || text.startsWith('{')) return false;
  account.token = text;
  account.refresh = cookieOf(res) || account.refresh;
  return true;
}

/** 调 n.novelia.cc 的接口；令牌过期时自动刷新一次再试 */
async function call(account, pathAndQuery, { raw = false, timeout = 30000 } = {}) {
  const go = () => fetch(`${API}/api/${pathAndQuery}`, {
    headers: { 'User-Agent': UA, Accept: raw ? '*/*' : 'application/json', ...(account?.token ? { Authorization: `Bearer ${account.token}` } : {}) },
    redirect: 'follow', signal: AbortSignal.timeout(timeout),
  });
  let res = await go().catch((e) => { throw err(502, `连不上 Novelia：${e.cause?.code || e.message}`); });
  if (res.status === 401 && account?.token && await refresh(account)) res = await go();
  if (raw) return res;
  const text = await res.text();
  if (!res.ok) {
    let msg = text.slice(0, 200);
    try { msg = JSON.parse(text).message || msg; } catch { /* 不是 JSON */ }
    throw err(res.status === 404 ? 404 : res.status === 401 || res.status === 403 ? 403 : 502, res.status === 401 || res.status === 403 ? `需要登录 Novelia 账号才能看（${msg || res.status}）` : `Novelia 返回错误 ${res.status}${msg ? '：' + msg : ''}`);
  }
  try { return JSON.parse(text); } catch { throw err(502, 'Novelia 返回的内容看不懂'); }
}

const int = (v, d, lo, hi) => { const n = Math.floor(Number(v)); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };
const enc = encodeURIComponent;
const absolute = (u) => (typeof u === 'string' && u ? (/^https?:\/\//.test(u) ? u : u.startsWith('/') ? API + u : u) : '');

// 统一成客户端好用的样子（字段名两边都兼容：接口是 camelCase，有的第三方客户端写的是 snake_case）
const pick = (o, a, b) => o?.[a] ?? o?.[b];
function webOutline(x) {
  return {
    provider: pick(x, 'providerId', 'provider_id'), id: pick(x, 'novelId', 'novel_id'),
    title: pick(x, 'titleZh', 'title_zh') || pick(x, 'titleJp', 'title_jp') || '', titleJp: pick(x, 'titleJp', 'title_jp') || '',
    type: x.type || '', keywords: x.keywords || [], attentions: x.attentions || [], extra: x.extra || '',
    total: x.total || 0, jp: x.jp || 0, translated: Math.max(x.sakura || 0, x.gpt || 0, x.youdao || 0, x.baidu || 0),
    updateAt: pick(x, 'updateAt', 'update_at') || null,
  };
}

async function handle(req, res, seg, q, lib, { json, fail, readJson, save, str }) {
  const M = req.method;
  const account = lib.cloud.novelia || (lib.cloud.novelia = {});
  try {
    if (seg[0] === 'status' && M === 'GET') return json(res, 200, { signedIn: !!account.token, username: account.username || '' });
    if (seg[0] === 'login' && M === 'POST') {
      const body = await readJson(req, 16 * 1024);
      const u = str(body.username, 100), p = typeof body.password === 'string' ? body.password.slice(0, 200) : '';
      if (!u || !p) return fail(res, 400, '请填写 Novelia 的用户名和密码');
      await login(account, u, p); save();
      return json(res, 200, { signedIn: true, username: account.username });
    }
    if (seg[0] === 'logout' && M === 'POST') {
      if (account.refresh) fetch(`${AUTH}/api/v1/auth/logout`, { method: 'POST', headers: { Cookie: account.refresh, 'User-Agent': UA } }).catch(() => {});
      lib.cloud.novelia = {}; save();
      return json(res, 200, { signedIn: false });
    }

    // 文库小说
    if (seg[0] === 'wenku' && seg.length === 1 && M === 'GET') {
      const page = int(q.get('page'), 0, 0, 9999), size = int(q.get('pageSize'), 24, 1, 48), level = int(q.get('level'), 0, 0, 6);
      const query = str(q.get('query') || '', 100);
      const key = `w|${page}|${size}|${level}|${query}|${!!account.token}`;
      const data = cached(key) || await call(account, `wenku?page=${page}&pageSize=${size}&query=${enc(query)}&level=${level}`);
      remember(key, data);
      return json(res, 200, {
        pages: data.pageNumber || 1,
        items: (data.items || []).map((x) => ({ id: x.id, title: x.titleZh || x.title || '', titleJp: x.title || '', cover: absolute(x.cover) })),
      });
    }
    if (seg[0] === 'wenku' && seg.length === 2 && M === 'GET') {
      const id = str(seg[1], 64);
      if (!/^[A-Za-z0-9_-]+$/.test(id)) return fail(res, 400, '编号不对');
      const key = `wd|${id}|${!!account.token}`;
      const x = cached(key) || await call(account, `wenku/${enc(id)}`);
      remember(key, x);
      return json(res, 200, {
        id, title: x.titleZh || x.title || '', titleJp: x.title || '', cover: absolute(x.cover),
        authors: x.authors || [], artists: x.artists || [], keywords: x.keywords || [], publisher: x.publisher || '', imprint: x.imprint || '',
        latestPublishAt: x.latestPublishAt || null, level: x.level || '', introduction: x.introduction || '',
        volumes: (x.volumes || []).map((v) => ({ asin: v.asin, title: v.titleZh || v.title || '', cover: absolute(v.cover), publishAt: v.publishAt || null })),
        files: (x.volumeJp || []).map((v) => ({ volumeId: v.volumeId, total: v.total || 0, sakura: v.sakura || 0, gpt: v.gpt || 0, youdao: v.youdao || 0, baidu: v.baidu || 0 })),
        signedIn: !!account.token,
      });
    }

    // 网络小说
    if (seg[0] === 'novel' && seg.length === 1 && M === 'GET') {
      const page = int(q.get('page'), 0, 0, 9999), size = int(q.get('pageSize'), 30, 1, 100);
      const query = str(q.get('query') || '', 100);
      const provider = /^[a-z,]+$/.test(q.get('provider') || '') ? q.get('provider') : PROVIDERS;
      const type = int(q.get('type'), 0, 0, 3), sort = int(q.get('sort'), 0, 0, 2), translate = int(q.get('translate'), 0, 0, 2), level = int(q.get('level'), 1, 0, 2);
      const key = `n|${page}|${size}|${query}|${provider}|${type}|${sort}|${translate}|${level}|${!!account.token}`;
      const data = cached(key) || await call(account, `novel?page=${page}&pageSize=${size}&query=${enc(query)}&provider=${enc(provider)}&type=${type}&level=${level}&translate=${translate}&sort=${sort}`);
      remember(key, data);
      return json(res, 200, { pages: data.pageNumber || 1, items: (data.items || []).map(webOutline) });
    }
    if (seg[0] === 'novel' && seg.length === 3 && M === 'GET') {
      const [provider, id] = [str(seg[1], 32), str(seg[2], 128)];
      if (!/^[a-z]+$/.test(provider) || !/^[A-Za-z0-9_.-]+$/.test(id)) return fail(res, 400, '编号不对');
      const key = `nd|${provider}|${id}|${!!account.token}`;
      const x = cached(key) || await call(account, `novel/${enc(provider)}/${enc(id)}`);
      remember(key, x);
      const toc = (x.toc || []);
      return json(res, 200, {
        provider, id, title: x.titleZh || x.titleJp || '', titleJp: x.titleJp || '',
        authors: (x.authors || []).map((a) => (typeof a === 'string' ? a : a.name)).filter(Boolean),
        type: x.type || '', keywords: x.keywords || [], attentions: x.attentions || [],
        introduction: x.introductionZh || x.introductionJp || '', wenkuId: x.wenkuId || null,
        chapters: toc.filter((t) => t.chapterId).length, totalCharacters: x.totalCharacters || null,
        toc: toc.slice(0, 2000).map((t) => ({ title: t.titleZh || t.titleJp || '', chapterId: t.chapterId || null })),
        jp: x.jp || 0, sakura: x.sakura || 0, gpt: x.gpt || 0, youdao: x.youdao || 0, baidu: x.baidu || 0,
        signedIn: !!account.token,
      });
    }

    // 下载 EPUB：文库按卷，网络小说整本。服务器取回来直接转给客户端，客户端再按普通文件导入书架
    if (seg[0] === 'file' && M === 'GET') {
      const mode = ['zh', 'zh-jp', 'jp-zh'].includes(q.get('mode')) ? q.get('mode') : 'zh';
      const order = (q.get('translations') || '').split(',').filter((t) => TRANSLATORS.includes(t));
      const translations = order.length ? order : TRANSLATORS;
      const tq = translations.map((t) => `&translations=${t}`).join('');
      const tag = `Y${translations.map((t) => t[0]).join('')}`;
      let url, name;
      if (q.get('kind') === 'wenku') {
        const id = str(q.get('id'), 64), vol = str(q.get('volume'), 300);
        if (!/^[A-Za-z0-9_-]+$/.test(id) || !vol) return fail(res, 400, '参数不对');
        name = [mode, tag, vol].join('.');
        url = `wenku/${enc(id)}/file/${enc(vol)}?mode=${mode}&translationsMode=priority${tq}&filename=${enc(name)}`;
      } else {
        const provider = str(q.get('provider'), 32), id = str(q.get('id'), 128);
        if (!/^[a-z]+$/.test(provider) || !/^[A-Za-z0-9_.-]+$/.test(id)) return fail(res, 400, '参数不对');
        const title = str(q.get('title'), 120).replace(/[\\/|:*?"<>]/g, '') || id;
        name = [mode, tag, title, 'epub'].join('.');
        url = `novel/${enc(provider)}/${enc(id)}/file?mode=${mode}&translationsMode=priority&type=epub${tq}&filename=${enc(name)}`;
      }
      const up = await call(account, url, { raw: true, timeout: 180000 });
      if (!up.ok) {
        const t = (await up.text()).slice(0, 200);
        return fail(res, up.status === 401 || up.status === 403 ? 403 : 502, up.status === 401 || up.status === 403 ? '需要登录 Novelia 账号才能下载' : `Novelia 没能生成文件（${up.status}${t ? '：' + t : ''}）`);
      }
      const len = Number(up.headers.get('content-length')) || 0;
      if (len > 200 * 1024 * 1024) return fail(res, 413, '文件太大了');
      const buf = Buffer.from(await up.arrayBuffer());
      if (buf.length < 100 || buf[0] !== 0x50 || buf[1] !== 0x4b) return fail(res, 502, 'Novelia 返回的不是 EPUB，可能这一卷还没有翻译');
      res.writeHead(200, {
        'Content-Type': 'application/epub+zip', 'Content-Length': buf.length, 'Cache-Control': 'no-store',
        'X-File-Name': enc(name.endsWith('.epub') ? name : name.replace(/\.(txt|epub)$/i, '') + '.epub'),
        'Access-Control-Expose-Headers': 'X-File-Name,Content-Length',
      });
      return res.end(buf);
    }
    return fail(res, 404, '没有这个接口');
  } catch (e) {
    return fail(res, e.status && e.status < 600 ? e.status : 502, e.message || 'Novelia 出错了');
  }
}

module.exports = { handle, API };
