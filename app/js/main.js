// 书架、详情、摘录、统计、设置、登录与路由。
import * as store from './store.js';
import { state, prefs } from './store.js';
import { h, icon, toast, dialog, confirmDialog, promptDialog, dropdown, fmtPercent, fmtSize, fmtDuration } from './ui.js';
import * as ai from './ai.js';
import * as theme from './theme.js';
import { mountShelf } from './shelf3d.js';

// 0.6 起立体书架是默认的书架视图（旧的“书脊”视图并入了它）
if (prefs.get('layout') === 'spine' || !prefs.get('layoutV')) { prefs.set('layout', 'shelf'); prefs.set('layoutV', 1); }

const app = document.getElementById('app');
const readerHost = document.getElementById('reader');

const view = {
  filter: prefs.get('filter', 'all'), // all | reading | finished | none | <合集 id> | series:<名> | stats | excerpts | settings
  sort: prefs.get('sort', 'recent'),
  layout: prefs.get('layout', 'shelf'), // shelf | grid | list
  query: '',
  selecting: false,
  selected: new Set(),
  detail: null, // 正在看详情的书
  spineIndex: 0,
  excerptType: 'all', excerptBook: null,
  settingsTab: 'account',
};

// ---------- 主题 ----------
export function applyTheme() {
  const t = prefs.get('theme', 'auto');
  const dark = t === 'dark' || (t === 'auto' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  theme.applyAccent(); // 主题色的深浅两套跟着切换
  // Windows 客户端：让系统的云母材质跟着应用的深浅色走
  try { window.__TAURI__?.window?.getCurrentWindow?.().setTheme(t === 'auto' ? null : t)?.catch?.(() => {}); } catch { /* 网页版没有这个接口 */ }
}
// Windows 11 客户端的窗口背景是系统云母材质，界面要让出透明的地方给它
(async () => {
  try {
    if (!store.isNativeShell || !navigator.userAgentData) return;
    const info = await navigator.userAgentData.getHighEntropyValues(['platformVersion']);
    if (navigator.userAgentData.platform === 'Windows' && parseInt(info.platformVersion, 10) >= 13) document.documentElement.classList.add('is-mica');
  } catch { /* 判断不了就用普通背景 */ }
})();
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme);
applyTheme();

// 安卓客户端的原生层在按下音量键时调用这里，阅读器监听 volumekey 事件来翻页
window.__volumeKey = (dir) => { window.dispatchEvent(new CustomEvent('volumekey', { detail: dir })); };

async function guard(job, okMessage) {
  try { await job(); if (okMessage) toast(okMessage); return true; }
  catch (e) { toast(e.message || '操作失败', { error: true }); return false; }
}

// ---------- 头像 ----------
function avatarEl(size = 32) {
  const p = store.profile();
  const el = h('span.avatar', { style: `--s:${size}px`, 'aria-hidden': 'true' }, h('span', (p.nickname || '?').slice(0, 1)));
  if (p.avatarAt) store.avatarUrl().then((url) => { if (url) el.replaceChildren(h('img', { src: url, alt: '' })); }).catch(() => {});
  return el;
}
function pickAvatar() {
  const input = h('input', { type: 'file', accept: 'image/*', hidden: true });
  input.addEventListener('change', () => {
    const f = input.files[0];
    if (f) guard(() => store.setAvatar(f), '头像已更新').then(() => renderAll());
  });
  document.body.append(input); input.click(); setTimeout(() => input.remove(), 60000);
}

// ---------- 登录 ----------
/** 登录 / 注册表单。onDone 在成功后调用。first：首次打开时显示“先在本机使用” */
function loginForm({ first = false, onDone }) {
  let mode = 'login';
  const url = h('input.field', {
    type: 'url', placeholder: 'https://books.example.com', autocomplete: 'url', required: true,
    value: store.account()?.url || (store.isNativeShell || !/^https?:$/.test(location.protocol) ? '' : location.origin),
  });
  const username = h('input.field', { type: 'text', autocomplete: 'username', required: true, maxLength: 32, placeholder: '用户名' });
  const password = h('input.field', { type: 'password', autocomplete: 'current-password', required: true, minLength: 6, placeholder: '至少 6 位' });
  const nickname = h('input.field', { type: 'text', maxLength: 40, placeholder: '显示在书架上的名字，可不填' });
  const invite = h('input.field', { type: 'password', placeholder: '启动服务端时设置的 SHIORI_KEY' });
  const regOnly = h('div.reg-only', h('label.field-label', '昵称'), nickname, h('label.field-label', '邀请码'), invite,
    h('p.field-hint', '注册需要邀请码，防止别人在你的服务器上开账号。第一个注册的账号会接管旧版本的书库。'));
  const error = h('p.form-error', { role: 'alert' });
  const submit = h('button.btn.is-primary.is-block', { type: 'submit' }, '登录');
  const tabs = h('div.segmented.is-wide', { role: 'tablist' });
  const draw = () => {
    tabs.replaceChildren(...[['login', '登录'], ['register', '注册账号']].map(([m, t]) => h('button' + (mode === m ? '.is-on' : ''), {
      type: 'button', role: 'tab', 'aria-selected': String(mode === m), onclick: () => { mode = m; draw(); },
    }, t)));
    regOnly.hidden = mode !== 'register';
    password.autocomplete = mode === 'register' ? 'new-password' : 'current-password';
    submit.textContent = mode === 'register' ? '注册并登录' : '登录';
    error.textContent = '';
  };
  draw();
  return h('form.login-form', {
    onsubmit: async (e) => {
      e.preventDefault();
      submit.disabled = true; error.textContent = '';
      const label = submit.textContent; submit.textContent = '正在连接…';
      try {
        await store.signIn(mode, { url: url.value, username: username.value, password: password.value, invite: invite.value, nickname: nickname.value });
        await onDone();
      } catch (err) { error.textContent = err.message; }
      finally { submit.disabled = false; submit.textContent = label; }
    },
  },
  tabs,
  h('label.field-label', '服务器地址'), url,
  h('label.field-label', '用户名'), username,
  h('label.field-label', '密码'), password,
  regOnly, error, submit,
  first && h('button.btn.is-quiet.is-block', { type: 'button', onclick: () => { store.useLocally(); startShelf(); } }, '先在本机使用，以后再登录'));
}

function renderWelcome() {
  app.replaceChildren(h('main.setup',
    h('div.setup-card',
      h('div.brand.is-large', h('img.brand-icon', { src: 'icon-96.png', alt: '' }), h('span.brand-name', 'スス子文庫')),
      h('p.setup-lead', '登录你自己服务器上的账号，书、进度、划线和批注会在每台设备上同步。不登录也能在这台设备上正常使用。'),
      loginForm({ first: true, onDone: afterSignIn }))));
}

async function afterSignIn() {
  document.querySelectorAll('dialog[open]').forEach((d) => d.close());
  startShelf();
  const n = await store.localLibrarySize();
  if (n && await confirmDialog('上传本机的书', `这台设备上还有 ${n} 本只存在本机的书。要把它们连同进度、划线批注和阅读时长一起上传到这个账号吗？`, { ok: '上传' })) {
    const t = toast('', { sticky: true });
    const r = await store.uploadLocalLibrary((i, total, b) => t.update(`正在上传 ${i} / ${total}：${b.title}`));
    t.done(r.failed ? `已上传 ${r.moved} 本，${r.failed} 本失败（留在本机书库）` : `已上传 ${r.moved} 本`, !!r.failed);
  }
}

// ---------- 书架 ----------
let els = null;
const coverCache = new Map(); // 已解析好的封面地址，避免重绘闪烁
const isSeries = (filter) => filter.startsWith('series:');
const PAGES = ['stats', 'excerpts', 'settings'];
const isPage = (filter) => PAGES.includes(filter);

function booksIn(filter) {
  const all = Object.values(state.books);
  if (filter === 'all') return all;
  if (filter === 'reading' || filter === 'finished') return all.filter((b) => store.statusOf(b) === filter);
  if (filter === 'none') return all.filter((b) => !b.collections.length);
  if (isPage(filter)) return [];
  if (isSeries(filter)) return all.filter((b) => b.series === filter.slice(7));
  return all.filter((b) => b.collections.includes(filter));
}
function filterName(filter) {
  if (isSeries(filter)) return filter.slice(7);
  return { all: '全部', reading: '在读', finished: '已读完', none: '未分类', stats: '阅读统计', excerpts: '摘录与批注', settings: '设置' }[filter]
    || state.collections[filter]?.name || '全部';
}
function openSeries(name) {
  if (!isSeries(view.filter)) view.back = view.filter;
  setFilter('series:' + name, true);
}
/** keepSelect：进出系列时保留多选状态，方便先找到书再勾选 */
function setFilter(filter, keepSelect = false) {
  view.filter = filter;
  if (!isSeries(filter) && !isPage(filter)) prefs.set('filter', filter);
  if (!keepSelect) exitSelect(false);
  view.spineIndex = 0;
  if (isPage(filter) || view.autoDetail) { view.detail = null; view.autoDetail = false; }
  renderAll();
  els.main.scrollTop = 0;
}
function setLayout(layout) {
  view.layout = layout; prefs.set('layout', layout);
  if (view.autoDetail) { view.detail = null; view.autoDetail = false; }
  exitSelect(false);
  renderAll();
}

function renderShelf() {
  const search = h('input.search-input', {
    type: 'search', placeholder: '书名、作者、画师、出版社', 'aria-label': '搜索书名、作者、画师、出版社',
    oninput: () => { view.query = search.value.trim().toLowerCase(); renderBody(); },
    onkeydown: (e) => { if (e.key === 'Escape') { search.value = ''; view.query = ''; searchBox.classList.remove('is-open'); renderBody(); } },
  });
  const searchBox = h('div.search',
    h('button.icon-btn', {
      type: 'button', 'aria-label': '搜索', title: '搜索',
      onclick: () => { searchBox.classList.add('is-open'); search.focus(); },
    }, icon('search')),
    search);
  search.addEventListener('blur', () => { if (!search.value) searchBox.classList.remove('is-open'); });
  const fileInput = h('input', {
    type: 'file', multiple: true, hidden: true, accept: '.epub,.cbz,.zip,application/epub+zip,application/zip',
    onchange: () => { importFiles([...fileInput.files]); fileInput.value = ''; },
  });

  els = {
    nav: h('nav.side-nav', { 'aria-label': '书架分类' }),
    me: h('button.me-chip', { type: 'button', onclick: () => { view.settingsTab = 'account'; setFilter('settings'); } }),
    heading: h('div.heading'),
    tools: h('div.tools'),
    body: h('div.body'),
    bar: h('div.select-bar', { hidden: true }),
    pill: h('button.continue-pill', { type: 'button', hidden: true }),
    detail: h('aside.detail', { hidden: true, 'aria-label': '图书详情' }),
    search, searchBox, fileInput,
  };
  els.layoutSeg = h('div.icon-seg', { role: 'group', 'aria-label': '查看方式' });
  els.sort = dropdown({
    label: '排序方式', value: view.sort, options: [['recent', '最近阅读'], ['added', '最近添加'], ['title', '按书名']],
    onChange: (v) => { view.sort = v; prefs.set('sort', v); renderBody(); },
  });
  els.selectBtn = h('button.icon-btn', { type: 'button', onclick: () => (view.selecting ? exitSelect() : enterSelect()) }, icon('checkCircle'));
  els.syncBtn = h('button.icon-btn', { type: 'button', onclick: manualSync });
  els.importBtn = h('button.btn.is-primary', { type: 'button', onclick: () => fileInput.click() }, icon('plus', 18), '导入');
  els.main = h('main.main', h('header.topbar', els.heading, els.tools), els.body, fileInput);

  app.replaceChildren(h('div.shell',
    h('aside.side',
      h('div.brand', h('img.brand-icon', { src: 'icon-96.png', alt: '' }), h('span.brand-name', 'スス子文庫')),
      els.nav, els.me),
    els.main, els.detail, els.pill, els.bar));
  renderAll();
}

function renderAll() {
  if (!els) return;
  if (isSeries(view.filter)) { if (!booksIn(view.filter).length) view.filter = view.back || 'all'; }
  else if (!['all', 'reading', 'finished', 'none', ...PAGES].includes(view.filter) && !state.collections[view.filter]) view.filter = 'all';
  if (view.detail && !state.books[view.detail]) view.detail = null;
  renderNav(); renderMe(); renderHeading(); renderTools(); renderBody(); renderBar(); renderPill(); renderDetail();
}

const NAV_COLORS = { all: '#3B82F6', reading: '#F59E0B', finished: '#10B981', none: '#8B5CF6', collection: '#EAB308', excerpts: '#14B8A6', stats: '#EC4899', settings: '#64748B' };
function renderNav() {
  const active = isSeries(view.filter) ? view.back || 'all' : view.filter;
  const item = (filter, iconName, label, color, count) => h('button.nav-item' + (active === filter ? '.is-active' : ''), {
    type: 'button', 'aria-current': active === filter ? 'page' : null, style: `--c:${color}`, onclick: () => setFilter(filter),
  }, icon(iconName, 20), h('span.nav-label', label), count != null && h('span.nav-count', count));
  const markCount = Object.values(state.marks).reduce((n, l) => n + Object.values(l).filter((m) => m.type !== 'bookmark').length, 0);
  els.nav.replaceChildren(
    item('all', 'books', '全部', NAV_COLORS.all, booksIn('all').length),
    item('reading', 'clock', '在读', NAV_COLORS.reading, booksIn('reading').length),
    item('finished', 'check', '已读完', NAV_COLORS.finished, booksIn('finished').length),
    item('none', 'inbox', '未分类', NAV_COLORS.none, booksIn('none').length),
    h('div.nav-section', h('span', '合集'),
      h('button.icon-btn.is-small', { type: 'button', 'aria-label': '新建合集', title: '新建合集', onclick: newCollection }, icon('plus', 16))),
    ...store.sortedCollections().map((c) => item(c.id, 'folder', c.name, NAV_COLORS.collection, booksIn(c.id).length)),
    h('button.nav-item.is-new', { type: 'button', onclick: newCollection }, icon('plus', 18), h('span.nav-label', '新建合集')),
    h('div.nav-section', h('span', '记录')),
    item('excerpts', 'quote', '摘录与批注', NAV_COLORS.excerpts, markCount || null),
    item('stats', 'chart', '阅读统计', NAV_COLORS.stats),
    item('settings', 'gear', '设置', NAV_COLORS.settings),
  );
}

function renderMe() {
  const p = store.profile();
  const status = store.isConfigured() ? (state.online ? '已同步' : state.authLost ? '登录已失效' : '离线') : '本机书库';
  els.me.replaceChildren(avatarEl(34), h('span.me-text', h('span.me-name', p.nickname), h('span.me-sub' + (state.authLost ? '.is-warn' : ''), status)));
  els.me.title = store.isConfigured() ? `${p.username} @ ${p.server}` : '只存在这台设备上的书库';
}

function renderHeading() {
  const f = view.filter;
  if (isSeries(f)) {
    els.heading.replaceChildren(
      h('button.icon-btn', { type: 'button', 'aria-label': `返回「${filterName(view.back || 'all')}」`, onclick: () => setFilter(view.back || 'all', true) }, icon('back')),
      h('h1', filterName(f)), h('span.heading-count', `${booksIn(f).length} 卷`));
    return;
  }
  if (isPage(f)) { els.heading.replaceChildren(h('h1', filterName(f))); return; }
  els.heading.replaceChildren(...[
    h('h1', filterName(f)),
    h('span.heading-count', String(booksIn(f).length)),
    state.collections[f] && h('button.icon-btn', { type: 'button', 'aria-label': '管理这个合集', title: '管理这个合集', onclick: manageCollection }, icon('more')),
  ].filter(Boolean));
}

function renderTools() {
  const page = isPage(view.filter);
  els.main.classList.toggle('is-page', page);
  if (page) {
    els.tools.replaceChildren(...(store.isConfigured() ? [els.syncBtn] : []));
    renderSync();
    return;
  }
  els.layoutSeg.replaceChildren(...[['shelf', 'spineView', '立体书架'], ['grid', 'gridView', '封面'], ['list', 'listView', '列表']].map(([v, ic, label]) => h('button' + (view.layout === v ? '.is-on' : ''), {
    type: 'button', 'aria-label': `${label}视图`, title: `${label}视图`, 'aria-pressed': String(view.layout === v), onclick: () => setLayout(v),
  }, icon(ic, 18))));
  const label = view.selecting ? '完成选择' : '选择';
  els.selectBtn.title = label; els.selectBtn.setAttribute('aria-label', label);
  els.selectBtn.classList.toggle('is-on', view.selecting);
  els.tools.replaceChildren(els.searchBox, els.layoutSeg, els.sort, els.selectBtn, ...(store.isConfigured() ? [els.syncBtn] : []), els.importBtn);
  renderSync();
}

function renderBody() {
  const f = view.filter;
  const shelfNow = !isPage(f) && view.layout === 'shelf' && !view.selecting && visibleBooks().length > 0;
  if (els.shelf && !shelfNow) { els.shelf.api.destroy(); els.shelf = null; }
  els.body.className = 'body';
  if (f === 'stats') return renderStats();
  if (f === 'excerpts') return renderExcerpts();
  if (f === 'settings') return renderSettings();
  const list = visibleBooks();
  if (!list.length) return renderEmpty();
  if (view.layout === 'list') return renderList(list);
  if (view.layout === 'shelf' && !view.selecting) return renderShelf3d(list);
  return renderGrid(list);
}

function visibleBooks() {
  let list = booksIn(view.filter);
  if (view.query) {
    list = list.filter((b) => [b.title, b.author, b.illustrator, b.publisher, b.series].filter(Boolean).join(' ').toLowerCase().includes(view.query));
  }
  const readAt = (b) => state.progress[b.id]?.updatedAt || 0;
  if (isSeries(view.filter)) list.sort(byVolume);
  else if (view.sort === 'title') list.sort((a, b) => store.natural(a.series || a.title, b.series || b.title) || byVolume(a, b));
  else if (view.sort === 'added') list.sort((a, b) => b.addedAt - a.addedAt);
  else list.sort((a, b) => Math.max(readAt(b), b.addedAt) - Math.max(readAt(a), a.addedAt));
  return list;
}
function byVolume(a, b) { // 没有卷号的排在最后
  return (a.volume ?? 1e9) - (b.volume ?? 1e9) || store.natural(a.title, b.title);
}
function fallbackHue(text) {
  let n = 0;
  for (const ch of text) n = (n * 31 + ch.codePointAt(0)) % 360;
  return n;
}
const bookLabel = (book) => (book.series ? (book.volume != null ? `${book.series} ${book.volume}` : book.series) : book.title);

/** 浏览时把同系列的书叠成一本；搜索、系列页里逐本显示 */
function groupSeries(list) {
  const stacking = prefs.get('stack', true) && !view.query && !isSeries(view.filter);
  if (!stacking) return list.map((b) => ({ book: b }));
  const groups = new Map();
  for (const b of list) if (b.series) groups.set(b.series, [...(groups.get(b.series) || []), b]);
  const done = new Set(), out = [];
  for (const b of list) {
    const group = b.series ? groups.get(b.series) : null;
    if (group && group.length > 1) { if (!done.has(b.series)) { done.add(b.series); out.push({ series: b.series, books: group }); } }
    else out.push({ book: b });
  }
  return out;
}

function coverOf(book) {
  const progress = state.progress[book.id]?.percent || 0;
  const cover = h('div.cover');
  const key = `${book.id}:${book.coverAt || 0}`;
  const img = h('img', { alt: '', loading: 'lazy', draggable: false });
  if (book.hasCover && coverCache.has(key)) { img.src = coverCache.get(key); cover.append(img); }
  else {
    const fb = h('div.cover-fallback', { style: `--hue:${fallbackHue(book.series || book.title)}` }, h('span', book.series || book.title));
    cover.append(fb);
    if (book.hasCover) {
      store.coverUrl(book).then((url) => { if (url) { coverCache.set(key, url); img.src = url; fb.replaceWith(img); } }).catch(() => {});
    }
  }
  if (store.statusOf(book) === 'reading') cover.append(h('span.ribbon', { style: `--p:${Math.min(1, progress).toFixed(3)}`, 'aria-hidden': 'true' }));
  return cover;
}
function coverSrc(book) { return book.hasCover ? coverCache.get(`${book.id}:${book.coverAt || 0}`) : null; }

function stackCard(name, books) {
  const sorted = [...books].sort(byVolume);
  const current = sorted.find((b) => store.statusOf(b) !== 'finished') || sorted[0]; // 封面用正在读的那一卷
  const cover = coverOf(current);
  const started = sorted.some((b) => store.statusOf(b) !== 'unread');
  if (view.selecting) { // 多选时：点开系列再勾选，角标显示这个系列里已选了几本
    const picked = books.filter((b) => view.selected.has(b.id)).length;
    cover.append(h('span.cover-check' + (picked ? '.is-on' : ''), picked ? String(picked) : null));
  }
  return h('button.book.is-stack', {
    type: 'button', title: view.selecting ? `点开「${name}」选择其中的书` : `${name}（共 ${books.length} 卷）`,
    onclick: () => openSeries(name),
    oncontextmenu: (e) => { e.preventDefault(); openSeries(name); },
  },
  h('div.stack', cover),
  h('span.book-title', name),
  h('span.book-meta',
    h('span.book-author', current.author || (current.format === 'cbz' ? '漫画' : '')),
    h('span.book-progress.is-done', started && current.volume != null ? `读到 ${current.volume} / 共 ${books.length} 卷` : `共 ${books.length} 卷`)));
}

/** 书的点按：多选时勾选；否则打开阅读。长按 / 右键进入多选 */
function pressable(el, book) {
  let pressTimer = null, longPressed = false;
  el.addEventListener('click', (e) => {
    if (e.target.closest('.info-btn')) return;
    if (longPressed) { longPressed = false; return; }
    if (view.selecting) toggleSelect(book.id); else openBook(book.id);
  });
  el.addEventListener('contextmenu', (e) => { e.preventDefault(); if (!view.selecting) enterSelect(book.id); });
  el.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' || view.selecting) return;
    longPressed = false;
    pressTimer = setTimeout(() => { longPressed = true; navigator.vibrate?.(10); enterSelect(book.id); }, 480);
  });
  for (const t of ['pointerup', 'pointercancel']) el.addEventListener(t, () => clearTimeout(pressTimer));
  el.addEventListener('pointermove', (e) => { if (Math.abs(e.movementX) + Math.abs(e.movementY) > 6) clearTimeout(pressTimer); });
  return el;
}
const infoBtn = (book) => h('span.info-btn', {
  role: 'button', tabIndex: 0, 'aria-label': `《${book.title}》的详情`, title: '详情',
  onclick: (e) => { e.stopPropagation(); showDetail(book.id); },
  onkeydown: (e) => { if (e.key === 'Enter') { e.stopPropagation(); showDetail(book.id); } },
}, icon('info', 18));

function bookCard(book) {
  const progress = state.progress[book.id]?.percent || 0;
  const status = store.statusOf(book);
  const selected = view.selected.has(book.id);
  const cover = coverOf(book);
  if (book.series && book.volume != null) cover.append(h('span.cover-vol', { 'aria-hidden': 'true' }, String(book.volume)));
  if (!state.downloaded.has(book.id)) cover.append(h('span.cover-badge', { title: '还没下载到这台设备，打开时边读边加载' }, icon('down', 14)));
  if (view.selecting) cover.append(h('span.cover-check' + (selected ? '.is-on' : ''), selected && icon('check', 16)));
  else cover.append(infoBtn(book));
  return pressable(h('button.book' + (selected ? '.is-selected' : ''), {
    type: 'button', 'aria-pressed': view.selecting ? String(selected) : null,
    title: [book.title, book.author && `作者：${book.author}`, book.illustrator && `插画：${book.illustrator}`].filter(Boolean).join('\n'),
  },
  cover,
  h('span.book-title', bookLabel(book)),
  h('span.book-meta',
    h('span.book-author', book.author || (book.format === 'cbz' ? '漫画' : '')),
    status === 'finished' ? h('span.book-progress.is-done', '读完')
      : status === 'reading' && h('span.book-progress', progress > 0 ? fmtPercent(Math.min(progress, 0.99)) : '在读'))), book);
}

function renderGrid(list) {
  els.body.className = 'body grid';
  els.body.replaceChildren(...groupSeries(list).map((g) => (g.book ? bookCard(g.book) : stackCard(g.series, g.books))));
}

// 列表视图：一行一本，像音乐播放器的歌曲列表
function renderList(list) {
  els.body.className = 'body list';
  const rows = groupSeries(list).map((g) => {
    if (g.series) {
      const first = [...g.books].sort(byVolume)[0];
      return h('button.row.is-stack', { type: 'button', onclick: () => openSeries(g.series) },
        h('span.row-cover', coverOf(first)),
        h('span.row-main', h('span.row-title', g.series), h('span.row-sub', h('span.tag', '系列'), first.author || '')),
        h('span.row-mid', first.publisher || ''),
        h('span.row-end', `${g.books.length} 卷`, icon('chevronRight', 18)));
    }
    const b = g.book;
    const p = state.progress[b.id]?.percent || 0;
    const st = store.statusOf(b);
    const selected = view.selected.has(b.id);
    const sec = store.secondsOf(b.id);
    return pressable(h('button.row' + (selected ? '.is-selected' : ''), { type: 'button', 'aria-pressed': view.selecting ? String(selected) : null },
      h('span.row-cover', coverOf(b)),
      h('span.row-main',
        h('span.row-title', bookLabel(b)),
        h('span.row-sub', h('span.tag', b.format === 'cbz' ? '漫画' : 'EPUB'), [b.author, b.illustrator && `插画 ${b.illustrator}`].filter(Boolean).join('　'))),
      h('span.row-mid', b.publisher || (b.series ? b.series : '')),
      h('span.row-end',
        h('span.row-progress' + (st === 'finished' ? '.is-done' : ''), st === 'finished' ? '读完' : st === 'reading' ? fmtPercent(Math.min(p, 0.99)) : '未读'),
        h('span.row-time', sec ? fmtDuration(sec) : ''),
        view.selecting ? h('span.row-check' + (selected ? '.is-on' : ''), selected && icon('check', 16)) : infoBtn(b))), b);
  });
  els.body.replaceChildren(...rows);
}

// 立体书架：书本沿弧线摆开，中间那本露出封面，下面是它的信息
function renderShelf3d(list) {
  els.body.className = 'body shelf';
  const items = groupSeries(list).map((g) => {
    const sorted = g.books ? [...g.books].sort(byVolume) : null;
    const b = g.book || sorted.find((x) => store.statusOf(x) !== 'finished') || sorted[0];
    return {
      key: g.series ? 's:' + g.series : b.id, book: b, group: g,
      title: g.series || (b.series ? b.series : b.title),
      volume: g.series ? null : b.series ? b.volume : null,
      colorKey: `${b.id}:${b.coverAt || 0}`, fallbackHue: fallbackHue(b.series || b.title),
      reading: store.statusOf(b) === 'reading',
    };
  });
  const keys = items.map((i) => i.key).join('|');
  if (els.shelf && els.shelf.keys === keys && els.body.contains(els.shelf.stage)) { drawShelfCaption(); return; }
  els.shelf?.api.destroy();
  const stage = h('div.shelf-host');
  const caption = h('div.shelf-caption', { 'aria-live': 'polite' });
  els.body.replaceChildren(stage, caption);
  view.spineIndex = Math.min(Math.max(0, view.spineIndex), items.length - 1);
  els.shelf = { keys, items, stage, caption };
  els.shelf.api = mountShelf(stage, items, {
    index: view.spineIndex,
    coverUrl: (b) => store.coverUrl(b),
    onFocus: (i) => { view.spineIndex = i; drawShelfCaption(); },
    onOpen: (i) => openShelfItem(items[i]),
  });
}
function openShelfItem(it) {
  if (!it) return;
  if (it.group.series) openSeries(it.group.series); else openBook(it.book.id);
}
function drawShelfCaption() {
  const sh = els.shelf;
  const it = sh?.items[view.spineIndex];
  if (!it) return;
  const b = it.book, total = sh.items.length;
  const st = store.statusOf(b), p = state.progress[b.id]?.percent || 0;
  const meta = it.group.series
    ? [b.author, `共 ${it.group.books.length} 卷`, b.volume != null && st !== 'unread' && `读到第 ${b.volume} 卷`]
    : [b.author, b.illustrator && `插画 ${b.illustrator}`, { reading: `在读 ${fmtPercent(Math.min(p, 0.99))}`, finished: '已读完', unread: '未读' }[st]];
  sh.caption.replaceChildren(
    h('div.cap-index', h('b', String(view.spineIndex + 1).padStart(2, '0')), h('span', `/ ${String(total).padStart(2, '0')}`)),
    h('div.cap-main',
      h('h2', it.title + (it.volume != null ? ` ${it.volume}` : '')),
      h('p', meta.filter(Boolean).join(' · ')),
      it.group.series ? null : h('div.cap-bar', h('span', { style: `width:${Math.round(Math.min(1, p) * 100)}%` }))),
    h('div.cap-actions',
      h('button.icon-btn', { type: 'button', 'aria-label': '上一本', onclick: () => sh.api.prev() }, icon('prev')),
      h('button.btn.is-primary', { type: 'button', onclick: () => openShelfItem(it) },
        it.group.series ? '打开系列' : p > 0 ? '继续阅读' : '开始阅读'),
      !it.group.series && h('button.btn', { type: 'button', onclick: () => showDetail(b.id) }, '详情'),
      h('button.icon-btn', { type: 'button', 'aria-label': '下一本', onclick: () => sh.api.next() }, icon('next'))));
  // 宽屏时书架旁边直接显示选中那本的详情
  if (!it.group.series && view.detail !== b.id && window.innerWidth > 1180 && (!view.detail || view.autoDetail)) { view.detail = b.id; view.autoDetail = true; renderDetail(); }
}

function renderEmpty() {
  els.body.className = 'body is-empty';
  let title, text, action = null;
  if (view.query) { title = `没有找到“${view.query}”`; text = '换个书名、作者、画师或出版社试试。'; }
  else if (!Object.keys(state.books).length) {
    title = '书架还是空的';
    text = store.isConfigured() ? '导入 EPUB 小说或 CBZ / ZIP 漫画，它们会出现在你的每台设备上。' : '导入 EPUB 小说或 CBZ / ZIP 漫画。现在是本机书库，登录账号后可以同步到其他设备。';
    action = h('button.btn.is-primary', { type: 'button', onclick: () => els.fileInput.click() }, icon('plus', 18), '导入第一本书');
  } else if (state.collections[view.filter]) { title = '这个合集还没有书'; text = '在书架上长按（或右键）一本书，选择“加入合集”。也可以直接在这里导入。'; }
  else if (view.filter === 'reading') { title = '没有正在读的书'; text = '打开任意一本书，它就会出现在这里。'; }
  else if (view.filter === 'finished') { title = '还没有读完的书'; text = '读到最后一页的书会自动出现在这里，也可以多选后手动标记。'; }
  else { title = '所有书都已归入合集'; text = ''; }
  els.body.replaceChildren(h('div.empty', h('h2', title), text && h('p', text), action));
}

// ---------- 继续阅读浮条 ----------
function lastRead() {
  let best = null, at = 0;
  for (const [id, p] of Object.entries(state.progress)) {
    if (state.books[id] && p.updatedAt > at && store.statusOf(state.books[id]) !== 'finished') { best = state.books[id]; at = p.updatedAt; }
  }
  return best;
}
function renderPill() {
  syncCoverAccent();
  const b = !view.selecting && !isPage(view.filter) && lastRead();
  els.pill.hidden = !b;
  if (!b) return;
  const p = state.progress[b.id]?.percent || 0;
  els.pill.onclick = () => openBook(b.id);
  els.pill.title = '继续阅读';
  els.pill.replaceChildren(
    h('span.pill-cover', coverOf(b)),
    h('span.pill-text', h('span.pill-title', bookLabel(b)), h('span.pill-sub', `继续阅读 · ${fmtPercent(Math.min(p, 0.99))}${b.author ? ' · ' + b.author : ''}`)),
    h('span.pill-ring', { style: `--p:${Math.min(1, p)}` }, icon('play', 16)));
}

// ---------- 图书详情 ----------
function showDetail(id) { view.detail = id; view.autoDetail = false; renderDetail(); }
function hideDetail() { view.detail = null; view.autoDetail = false; renderDetail(); }
function renderDetail() {
  const b = view.detail && state.books[view.detail];
  els.detail.hidden = !b;
  document.body.classList.toggle('has-detail', !!b);
  if (!b) return;
  const p = state.progress[b.id]?.percent || 0;
  const st = store.statusOf(b);
  const sec = store.secondsOf(b.id);
  const marks = store.marksOf(b.id);
  const hl = marks.filter((m) => m.type === 'highlight').length;
  const desc = h('p.detail-desc', b.description || '还没有简介。可以点“编辑信息”自己写一段。');
  const more = b.description && b.description.length > 160 && h('button.link-btn', { type: 'button', onclick: () => { desc.classList.toggle('is-open'); more.textContent = desc.classList.contains('is-open') ? '收起' : '展开全部'; } }, '展开全部');
  const facts = [
    b.illustrator && ['插画', b.illustrator], b.publisher && ['出版社', b.publisher],
    b.series && ['系列', b.volume != null ? `${b.series} · 第 ${b.volume} 卷` : b.series],
    ['格式', b.format === 'cbz' ? '漫画（CBZ / ZIP）' : 'EPUB'], ['大小', fmtSize(b.size || 0)],
    ['阅读时长', sec ? fmtDuration(sec) : '还没开始'],
    ['加入书架', new Date(b.addedAt).toLocaleDateString()],
  ].filter(Boolean);
  els.detail.replaceChildren(
    h('header.detail-head',
      h('button.icon-btn', { type: 'button', 'aria-label': '关闭详情', onclick: hideDetail }, icon('close')),
      h('span', '图书详情')),
    h('div.detail-scroll',
      h('div.detail-top',
        h('div.detail-cover', coverOf(b)),
        h('div.detail-id',
          h('h2', b.title),
          b.author && h('button.link-btn.detail-author', { type: 'button', onclick: () => { els.search.value = b.author; view.query = b.author.toLowerCase(); els.searchBox.classList.add('is-open'); setFilter('all'); } }, b.author, icon('chevronRight', 16)),
          h('p.detail-status', h('span.status-dot.is-' + st), { reading: `在读 · ${fmtPercent(Math.min(p, 0.99))}`, finished: '已读完', unread: '未读' }[st]),
          b.rating > 0 && h('p.detail-stars', { 'aria-label': `${b.rating} 星` }, '★'.repeat(b.rating) + '☆'.repeat(5 - b.rating)),
          h('div.detail-tags', b.collections.map((c) => state.collections[c] && h('button.chip-tag', { type: 'button', onclick: () => setFilter(c) }, state.collections[c].name))))),
      h('div.detail-actions',
        h('button.btn.is-primary.is-grow', { type: 'button', onclick: () => openBook(b.id) }, icon('dict', 18), p > 0 ? '继续阅读' : '开始阅读'),
        h('button.btn', { type: 'button', onclick: () => editBook(b.id) }, '编辑信息')),
      h('section.detail-sec', h('h3', '简介'), desc, more),
      b.review && h('section.detail-sec', h('h3', '我的书评'), h('p.detail-review', b.review)),
      marks.length > 0 && h('section.detail-sec',
        h('button.detail-link', { type: 'button', onclick: () => { view.excerptBook = b.id; setFilter('excerpts'); } },
          icon('quote', 18), h('span', `${hl} 条划线，${marks.length - hl} 条书签与笔记`), icon('chevronRight', 18))),
      h('dl.facts.detail-facts', facts.map(([k, v]) => [h('dt', k), h('dd', v)])),
      h('div.detail-more',
        store.isConfigured() && (state.downloaded.has(b.id)
          ? h('button.btn.is-quiet', { type: 'button', onclick: () => removeCopies([b.id]) }, '移除本机副本')
          : h('button.btn.is-quiet', { type: 'button', onclick: () => downloadBooks([b.id]) }, icon('down', 18), '下载到本机')),
        h('button.btn.is-quiet.is-danger', { type: 'button', onclick: () => deleteBooks([b.id]) }, icon('trash', 18), '删除'))));
}

function renderSync() {
  if (!store.isConfigured()) return;
  const label = state.syncing ? '正在同步' : state.online ? '已同步，点击立即同步' : state.authLost ? '登录已失效，请重新登录' : '离线，点击重试';
  els.syncBtn.replaceChildren(icon(state.online || state.syncing ? 'sync' : 'cloudOff'));
  els.syncBtn.className = 'icon-btn' + (state.syncing ? ' is-spinning' : '') + (!state.online && !state.syncing ? ' is-warn' : '');
  els.syncBtn.title = label; els.syncBtn.setAttribute('aria-label', label);
}
async function manualSync() {
  if (state.authLost) { view.settingsTab = 'account'; setFilter('settings'); return; }
  try { await store.sync(); toast('已同步'); } catch (e) { toast(e.message, { error: true }); }
}

// ---------- 多选 ----------
function enterSelect(id) {
  view.selecting = true; view.selected = new Set(id ? [id] : []);
  renderTools(); renderBody(); renderBar(); renderPill();
}
function exitSelect(render = true) {
  view.selecting = false; view.selected.clear();
  if (render) { renderTools(); renderBody(); renderBar(); renderPill(); }
}
function toggleSelect(id) {
  if (view.selected.has(id)) view.selected.delete(id); else view.selected.add(id);
  renderBody(); renderBar();
}
function renderBar() {
  els.bar.hidden = !view.selecting;
  if (!view.selecting) return;
  const ids = [...view.selected].filter((id) => state.books[id]);
  const n = ids.length;
  const inCollection = !!state.collections[view.filter];
  const act = (label, fn, cls = '') => h('button.btn' + cls, { type: 'button', disabled: !n, onclick: () => fn(ids) }, label);
  els.bar.replaceChildren(
    h('span.select-count', n ? `已选 ${n} 本` : '点选要整理的书'),
    h('div.select-actions',
      act('加入合集', pickCollections, '.is-primary'),
      inCollection && act('移出本合集', removeFromCurrent),
      n === 1 ? act('详情', ([id]) => { exitSelect(); showDetail(id); }) : act('设为系列', setSeries),
      n === 1 && act('编辑信息', ([id]) => editBook(id)),
      act('标记状态', setStatus),
      store.isConfigured() && ids.some((id) => !state.downloaded.has(id)) && act('下载到本机', downloadBooks),
      store.isConfigured() && ids.some((id) => state.downloaded.has(id)) && act('移除本机副本', removeCopies),
      act('删除', deleteBooks, '.is-danger'),
      h('button.btn.is-quiet', { type: 'button', onclick: () => exitSelect() }, '完成')),
  );
}

function pickCollections(ids) {
  const books = ids.map((id) => state.books[id]);
  return dialog('加入合集', (close) => {
    const listEl = h('div.check-list');
    const boxes = new Map();
    const addRow = (c, checked, mixed = false) => {
      const box = h('input', { type: 'checkbox', checked, indeterminate: mixed });
      boxes.set(c.id, box);
      listEl.append(h('label.check-row', box, h('span', c.name)));
    };
    for (const c of store.sortedCollections()) {
      const count = books.filter((b) => b.collections.includes(c.id)).length;
      addRow(c, count === books.length, count > 0 && count < books.length);
    }
    const empty = h('p.dialog-text', '还没有合集。在下面起个名字，新建第一个。');
    if (!boxes.size) listEl.append(empty);
    const name = h('input.field', { type: 'text', placeholder: '新合集的名字', maxLength: 60, 'aria-label': '新合集的名字' });
    const create = async () => {
      const v = name.value.trim(); if (!v) return;
      await guard(async () => { const c = await store.createCollection(v); empty.remove(); addRow(c, true); name.value = ''; });
    };
    name.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); create(); } });
    return h('div.dialog-body', listEl,
      h('div.inline-form', name, h('button.btn', { type: 'button', onclick: create }, '新建')),
      h('div.dialog-actions',
        h('button.btn', { type: 'button', onclick: () => close() }, '取消'),
        h('button.btn.is-primary', {
          type: 'button',
          onclick: async () => {
            const ok = await guard(async () => {
              for (const b of books) {
                const set = new Set(b.collections);
                for (const [cid, box] of boxes) {
                  if (box.indeterminate) continue;
                  if (box.checked) set.add(cid); else set.delete(cid);
                }
                const next = [...set];
                if (next.length !== b.collections.length || next.some((c) => !b.collections.includes(c))) {
                  await store.updateBook(b.id, { collections: next });
                }
              }
            }, '合集已更新');
            if (ok) { close(); exitSelect(); }
          },
        }, '保存')));
  });
}

async function removeFromCurrent(ids) {
  const cid = view.filter;
  const ok = await guard(async () => {
    for (const id of ids) await store.updateBook(id, { collections: state.books[id].collections.filter((c) => c !== cid) });
  }, `已移出「${filterName(cid)}」`);
  if (ok) exitSelect();
}
async function removeCopies(ids) {
  await guard(async () => { for (const id of ids) await store.removeLocalCopy(id); }, '已移除本机副本，书仍保留在服务器上');
  exitSelect();
}
async function downloadBooks(ids) {
  const todo = ids.filter((id) => !state.downloaded.has(id));
  exitSelect();
  const t = toast('', { sticky: true });
  let failed = 0;
  for (const [i, id] of todo.entries()) {
    const book = state.books[id];
    const label = `正在下载 ${i + 1} / ${todo.length}：${store.seriesLabel(book)}`;
    t.update(label);
    try { await store.downloadBook(book, (p) => t.update(`${label}　${Math.round(p * 100)}%`)); }
    catch { failed++; }
  }
  t.done(failed ? `${todo.length - failed} 本已下载，${failed} 本失败，请检查网络后重试` : `已下载 ${todo.length} 本到本机`, !!failed);
}

const STATUSES = [['', '按进度自动'], ['reading', '在读'], ['finished', '已读完']];
function setStatus(ids) {
  return dialog('标记状态', (close) => h('div.dialog-body',
    h('div.menu', STATUSES.map(([value, label]) => h('button.menu-item', {
      type: 'button',
      onclick: async () => {
        const ok = await guard(async () => { for (const id of ids) await store.updateBook(id, { status: value }); }, value ? `已标为「${label}」` : '已改回按进度自动判断');
        if (ok) { close(); exitSelect(); }
      },
    }, label))),
    h('p.field-hint', '手动标记不会改动阅读进度，下次打开仍然从上次的位置继续。')));
}

function commonPrefix(titles) {
  let prefix = titles[0] || '';
  for (const t of titles) { while (prefix && !t.startsWith(prefix)) prefix = prefix.slice(0, -1); }
  return prefix.replace(/[\s　_\-—~～:：(（\[【第]*\d*\s*$/, '').trim();
}
/** 把选中的几本书设成同一个系列，并自动编卷号 */
function setSeries(ids) {
  const books = ids.map((id) => state.books[id]).sort((a, b) => store.natural(a.title, b.title));
  const existing = books.find((b) => b.series)?.series;
  const guess = existing || store.guessSeries(books[0].title)?.series || commonPrefix(books.map((b) => b.title));
  return dialog('设为系列', (close) => {
    const name = h('input.field', { type: 'text', value: guess, maxLength: 200, placeholder: '系列的名字', 'aria-label': '系列的名字' });
    const apply = async (series) => {
      // 卷号优先取书名里的数字；取不到或有重复，就按书名顺序从 1 开始编
      let volumes = books.map((b) => store.guessSeries(b.title)?.volume ?? b.volume ?? null);
      if (volumes.includes(null) || new Set(volumes).size !== volumes.length) volumes = books.map((_, i) => i + 1);
      const ok = await guard(async () => {
        for (const [i, b] of books.entries()) await store.updateBook(b.id, series ? { series, volume: volumes[i] } : { series: '', volume: null });
      }, series ? `已归入系列「${series}」` : '已取消系列');
      if (ok) { close(); exitSelect(); }
    };
    return h('form.dialog-body', { onsubmit: (e) => { e.preventDefault(); if (name.value.trim()) apply(name.value.trim()); } },
      h('label.field-label', '系列的名字'), name,
      h('p.field-hint', `这 ${books.length} 本书会按书名里的数字编卷号；书名里没有数字的，按书名顺序从 1 开始。编错的可以单选一本，在“编辑信息”里改。`),
      h('div.dialog-actions',
        books.some((b) => b.series) && h('button.btn.is-danger', { type: 'button', onclick: () => apply('') }, '取消系列'),
        h('button.btn', { type: 'button', onclick: () => close() }, '取消'),
        h('button.btn.is-primary', { type: 'submit' }, '保存')));
  });
}

async function deleteBooks(ids) {
  const what = ids.length === 1 ? `《${state.books[ids[0]].title}》` : `这 ${ids.length} 本书`;
  const where = store.isConfigured() ? '会从服务器和所有设备上删除' : '会从这台设备上删除';
  if (!await confirmDialog('删除书籍', `${what}${where}，阅读进度、划线和批注也会一并清除。`, { ok: '删除', danger: true })) return;
  const ok = await guard(async () => { for (const id of ids) await store.deleteBook(id); }, '已删除');
  if (ok) exitSelect();
}

function editBook(id) {
  const book = state.books[id];
  return dialog('编辑信息', (close) => {
    const title = h('input.field', { type: 'text', value: book.title, maxLength: 200, required: true });
    const author = h('input.field', { type: 'text', value: book.author, maxLength: 200 });
    const illustrator = h('input.field', { type: 'text', value: book.illustrator || '', maxLength: 200 });
    const publisher = h('input.field', { type: 'text', value: book.publisher || '', maxLength: 200, placeholder: '例如：电击文库' });
    const description = h('textarea.field.is-area', { value: book.description || '', maxLength: 8000, rows: 5, placeholder: '这本书讲了什么？' });
    const review = h('textarea.field.is-area', { value: book.review || '', maxLength: 5000, rows: 4, placeholder: '读完有什么想说的？' });
    let rating = book.rating || 0;
    const stars = h('div.stars', { role: 'group', 'aria-label': '评分' });
    const drawStars = () => stars.replaceChildren(...[1, 2, 3, 4, 5].map((n) => h('button' + (n <= rating ? '.is-on' : ''), {
      type: 'button', 'aria-label': `${n} 星`, 'aria-pressed': String(n <= rating), onclick: () => { rating = rating === n ? 0 : n; drawStars(); },
    }, icon(n <= rating ? 'starOn' : 'star', 26))));
    drawStars();
    let status = book.status || '';
    const statusSeg = h('div.segmented', { role: 'group', 'aria-label': '阅读状态' });
    const drawStatus = () => statusSeg.replaceChildren(...STATUSES.map(([value, label]) => h('button' + (status === value ? '.is-on' : ''), {
      type: 'button', onclick: () => { status = value; drawStatus(); },
    }, label)));
    drawStatus();
    const series = h('input.field', { type: 'text', value: book.series || '', maxLength: 200, placeholder: '不属于系列就留空', list: 'series-names' });
    const volume = h('input.field', { type: 'number', value: book.volume ?? '', min: 0, step: 'any', placeholder: '例如 3', inputMode: 'decimal' });
    const names = [...new Set(Object.values(state.books).map((b) => b.series).filter(Boolean))];
    return h('form.dialog-body', {
      onsubmit: async (e) => {
        e.preventDefault();
        const patch = {
          title: title.value, author: author.value, illustrator: illustrator.value.trim(), publisher: publisher.value.trim(), status,
          rating, review: review.value.trim(), description: description.value.trim(),
          series: series.value.trim(), volume: volume.value === '' ? null : Number(volume.value),
        };
        if (await guard(() => store.updateBook(id, patch), '已保存')) { close(); exitSelect(false); renderAll(); }
      },
    },
    h('label.field-label', '书名'), title,
    h('div.field-pair.is-even',
      h('div', h('label.field-label', '作者'), author),
      h('div', h('label.field-label', '插画'), illustrator)),
    h('label.field-label', '出版社'), publisher,
    h('label.field-label', '简介'), description,
    h('label.field-label', '阅读状态'), statusSeg,
    h('div.field-pair',
      h('div', h('label.field-label', '系列'), series),
      h('div', h('label.field-label', '卷号'), volume)),
    h('datalist', { id: 'series-names' }, names.map((n) => h('option', { value: n }))),
    h('p.field-hint', '填了系列和卷号，书架上会显示成“系列名 + 卷号”，同系列的书会叠在一起并按卷号排序。'),
    h('label.field-label', '我的评分'), stars,
    h('label.field-label', '书评'), review,
    h('div.dialog-actions',
      h('button.btn', { type: 'button', onclick: () => close() }, '取消'),
      h('button.btn.is-primary', { type: 'submit' }, '保存')));
  });
}

// ---------- 合集 ----------
async function newCollection() {
  const name = await promptDialog('新建合集', { label: '合集名字', placeholder: '例如：正在追的轻小说', ok: '新建' });
  if (!name) return;
  let created;
  if (await guard(async () => { created = await store.createCollection(name); })) setFilter(created.id);
}
function manageCollection() {
  const col = state.collections[view.filter];
  return dialog(`合集「${col.name}」`, (close) => h('div.dialog-body',
    h('div.menu',
      h('button.menu-item', {
        type: 'button',
        onclick: async () => {
          close();
          const name = await promptDialog('重命名合集', { label: '合集名字', value: col.name });
          if (name) guard(() => store.renameCollection(col.id, name), '已重命名');
        },
      }, '重命名'),
      h('button.menu-item.is-danger', {
        type: 'button',
        onclick: async () => {
          close();
          if (await confirmDialog('删除合集', `只删除合集「${col.name}」，里面的书会留在书架上。`, { ok: '删除合集', danger: true })) {
            if (await guard(() => store.deleteCollection(col.id), '合集已删除')) setFilter('all');
          }
        },
      }, '删除合集（保留里面的书）'))));
}

// ---------- 摘录与批注 ----------
export const HL_COLORS = { blue: '#7FB3E6', pink: '#F49AB5', yellow: '#F2CF5B', green: '#8FD19E' };
const MARK_LABEL = { highlight: '划线', note: '笔记', bookmark: '书签' };
function renderExcerpts() {
  els.body.className = 'body excerpts';
  const types = [['all', '全部'], ['highlight', '划线'], ['annotated', '有批注'], ['note', '笔记'], ['bookmark', '书签']];
  const match = (m) => view.excerptType === 'all' || (view.excerptType === 'annotated' ? m.type === 'highlight' && m.text : m.type === view.excerptType);
  const q = view.query;
  const groups = Object.entries(state.marks)
    .filter(([id]) => state.books[id] && (!view.excerptBook || view.excerptBook === id))
    .map(([id, list]) => [state.books[id], Object.values(list).filter(match)
      .filter((m) => !q || `${m.excerpt} ${m.text} ${m.chapter}`.toLowerCase().includes(q))
      .sort((a, b) => a.percent - b.percent || a.createdAt - b.createdAt)])
    .filter(([, list]) => list.length)
    .sort((a, b) => Math.max(...b[1].map((m) => m.updatedAt || m.createdAt)) - Math.max(...a[1].map((m) => m.updatedAt || m.createdAt)));
  const total = groups.reduce((n, [, l]) => n + l.length, 0);
  const search = h('input.field.is-pill', { type: 'search', value: view.query, placeholder: '搜索摘录和批注', 'aria-label': '搜索摘录和批注',
    oninput: (e) => { view.query = e.target.value.trim().toLowerCase(); clearTimeout(search.t); search.t = setTimeout(renderBody, 200); } });
  const head = h('div.ex-head',
    h('div.segmented', { role: 'group', 'aria-label': '筛选' }, types.map(([v, t]) => h('button' + (view.excerptType === v ? '.is-on' : ''), {
      type: 'button', onclick: () => { view.excerptType = v; renderBody(); },
    }, t))),
    search,
    view.excerptBook && h('button.chip-tag.is-on', { type: 'button', onclick: () => { view.excerptBook = null; renderBody(); } }, `只看《${bookLabel(state.books[view.excerptBook])}》`, icon('close', 14)),
    h('span.ex-count', `${total} 条记录 · ${groups.length} 本书`));
  if (!groups.length) {
    els.body.replaceChildren(head, h('div.empty', h('h2', '还没有摘录'), h('p', '阅读时长按文字可以划线、写批注；点顶部的书签按钮可以记下这一页。它们都会收在这里。')));
    return;
  }
  const card = (book, m) => h('article.ex-card', { style: `--hl:${HL_COLORS[m.color] || HL_COLORS.blue}` },
    h('div.ex-card-top', h('span.ex-label', m.type === 'highlight' ? '原文摘录' : m.type === 'note' ? '这一页的笔记' : '书签'),
      h('span.ex-type.is-' + m.type, m.type === 'highlight' && m.text ? '批注' : MARK_LABEL[m.type])),
    m.type === 'highlight' ? h('blockquote.ex-quote', m.excerpt) : m.excerpt && h('p.ex-excerpt', m.excerpt + '…'),
    m.text && h('div.ex-note', h('span.ex-label', m.type === 'highlight' ? '个人批注' : '笔记'), h('p', m.text)),
    h('div.ex-foot',
      h('span.ex-where', `${m.chapter || ''}${m.chapter ? ' · ' : ''}${fmtPercent(Math.max(m.percent, 0.01))} · ${new Date(m.createdAt).toLocaleDateString()}`),
      h('div.ex-actions',
        h('button.btn.is-soft-sm', { type: 'button', onclick: () => openBook(book.id, m.id) }, '回到原文'),
        (m.excerpt || m.text) && h('button.icon-btn', { type: 'button', 'aria-label': '复制', title: '复制', onclick: () => copyText(`${m.excerpt || ''}${m.text ? `\n—— ${m.text}` : ''}\n《${book.title}》${m.chapter ? ' ' + m.chapter : ''}`) }, icon('copy', 18)),
        m.type !== 'bookmark' && h('button.icon-btn', { type: 'button', 'aria-label': '编辑批注', title: '编辑批注', onclick: () => editAnnotation(book.id, m) }, icon('pen', 18)),
        h('button.icon-btn', { type: 'button', 'aria-label': '删除', title: '删除', onclick: async () => {
          if (await confirmDialog('删除这条记录', m.type === 'highlight' ? '划线和它的批注都会删除。' : '删除后无法恢复。', { ok: '删除', danger: true })) store.removeMark(book.id, m.id);
        } }, icon('trash', 18)))));
  els.body.replaceChildren(head, ...groups.map(([book, list]) => h('section.ex-group',
    h('header.ex-book', h('span.ex-cover', coverOf(book)),
      h('div', h('h2', bookLabel(book)), h('p', `${list.length} 条书签与标记`)),
      h('button.icon-btn', { type: 'button', 'aria-label': '图书详情', onclick: () => showDetail(book.id) }, icon('info'))),
    h('div.ex-list', list.map((m) => card(book, m))))));
}
async function copyText(text) {
  try { await navigator.clipboard.writeText(text); toast('已复制'); } catch { toast('复制失败，请手动选择文字', { error: true }); }
}
export function editAnnotation(bookId, mark) {
  return dialog(mark.type === 'highlight' ? '批注' : '笔记', (close) => {
    const area = h('textarea.field.is-area', { value: mark.text || '', rows: 5, maxLength: 5000, placeholder: '写下你的想法…' });
    setTimeout(() => area.focus(), 40);
    return h('form.dialog-body', { onsubmit: (e) => { e.preventDefault(); store.saveMark(bookId, { ...mark, text: area.value.trim() }); close(); toast('已保存'); } },
      mark.excerpt && h('blockquote.note-quote', mark.excerpt),
      area,
      h('div.dialog-actions',
        h('button.btn', { type: 'button', onclick: () => close() }, '取消'),
        h('button.btn.is-primary', { type: 'submit' }, '保存')));
  });
}

// ---------- 阅读统计 ----------
function renderStats() {
  const range = view.statRange || 30;
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const days = Array.from({ length: range }, (_, i) => { const d = new Date(today); d.setDate(d.getDate() - (range - 1 - i)); return d; });
  const perDay = days.map((d) => Object.values(state.stats[store.dayKey(d)] || {}).reduce((a, b) => a + b, 0));
  const total = perDay.reduce((a, b) => a + b, 0);
  const perBook = new Map();
  for (const d of days) for (const [id, sec] of Object.entries(state.stats[store.dayKey(d)] || {})) perBook.set(id, (perBook.get(id) || 0) + sec);
  const ranked = [...perBook].filter(([id]) => state.books[id]).sort((a, b) => b[1] - a[1]);
  const marks = Object.values(state.marks).reduce((n, list) => n + Object.keys(list).length, 0);

  // 柱状图：7 / 30 天按天，90 天按周，365 天按月
  let buckets;
  if (range <= 30) buckets = days.map((d, i) => ({ label: `${d.getMonth() + 1}/${d.getDate()}`, short: range === 7 ? '日一二三四五六'[d.getDay()] : (d.getDate() === 1 || i === 0 || i % 5 === 0 ? `${d.getDate()}` : ''), sec: perDay[i] }));
  else if (range === 90) {
    buckets = [];
    for (let i = 0; i < days.length; i += 7) buckets.push({ label: `${days[i].getMonth() + 1}/${days[i].getDate()} 起的一周`, short: buckets.length % 2 ? '' : `${days[i].getMonth() + 1}/${days[i].getDate()}`, sec: perDay.slice(i, i + 7).reduce((a, b) => a + b, 0) });
  } else {
    const by = new Map();
    days.forEach((d, i) => { const k = `${d.getFullYear()}-${d.getMonth()}`; const b = by.get(k) || { label: `${d.getFullYear()} 年 ${d.getMonth() + 1} 月`, short: `${d.getMonth() + 1}月`, sec: 0 }; b.sec += perDay[i]; by.set(k, b); });
    buckets = [...by.values()];
  }
  const peak = Math.max(1, ...buckets.map((b) => b.sec));
  const week = [1, 2, 3, 4, 5, 6, 0].map((w) => ({ label: '周' + '日一二三四五六'[w], short: '日一二三四五六'[w], sec: days.reduce((n, d, i) => n + (d.getDay() === w ? perDay[i] : 0), 0) }));
  const weekPeak = Math.max(1, ...week.map((b) => b.sec));
  const bars = (list, top, cls = '') => h('div.bars' + cls, { role: 'img', 'aria-label': list.filter((b) => b.sec).map((b) => `${b.label} ${fmtDuration(b.sec)}`).join('，') || '这段时间没有阅读记录' },
    list.map((b) => h('div.bar-col', { title: `${b.label}：${fmtDuration(b.sec)}` },
      h('div.bar-track', h('div.bar' + (b.sec === top && b.sec > 0 ? '.is-peak' : ''), { style: `height:${b.sec ? Math.max(3, (b.sec / top) * 100) : 0}%` })),
      h('span.bar-label', b.short))));
  const hours = Math.floor(total / 3600), minutes = Math.round((total % 3600) / 60);
  const seg = h('div.segmented', { role: 'group', 'aria-label': '统计范围' }, [7, 30, 90, 365].map((n) => h('button' + (n === range ? '.is-on' : ''), {
    type: 'button', onclick: () => { view.statRange = n; renderBody(); },
  }, `${n} 天`)));
  const fact = (value, unit, label) => h('div.fact', h('div.fact-value', String(value), h('small', unit)), h('div.fact-label', label));

  els.body.className = 'body stats';
  els.body.replaceChildren(
    h('section.stat-hero',
      h('div',
        h('div.stat-caption', `近 ${range} 天的阅读时长`),
        h('div.stat-big', hours > 0 && [String(hours), h('small', '小时')], String(minutes), h('small', '分'))),
      seg),
    h('section.stat-facts',
      fact(perDay.filter(Boolean).length, '天', '有阅读的天数'),
      fact(ranked.length, '本', '读过的书'),
      fact(marks, '条', '书签与标记')),
    h('section.stat-card', h('h2', range <= 30 ? '每天读了多久' : range === 90 ? '每周读了多久' : '每月读了多久'), bars(buckets, peak, buckets.length > 14 ? '.is-dense' : '')),
    h('section.stat-card', h('h2', '一周里哪天读得多'), bars(week, weekPeak)),
    h('section.stat-card', h('h2', '每本书读了多久'),
      ranked.length ? h('div.stat-books', ranked.slice(0, 30).map(([id, sec]) => h('button.stat-book', {
        type: 'button', title: '打开这本书', onclick: () => openBook(id),
      },
      h('span.stat-book-title', store.seriesLabel(state.books[id])),
      h('span.stat-book-time', fmtDuration(sec)),
      h('span.stat-book-bar', h('span', { style: `width:${Math.max(2, (sec / ranked[0][1]) * 100)}%` })))))
        : h('p.stat-empty', '这段时间还没有阅读记录。打开一本书读一会儿，这里就会有数据。')),
  );
}

// ---------- 设置 ----------
function segOf(label, options, current, onPick) {
  return h('div.segmented', { role: 'group', 'aria-label': label }, options.map(([v, t]) => h('button' + (current === v ? '.is-on' : ''), {
    type: 'button', onclick: () => onPick(v),
  }, t)));
}
const row = (label, control, hint) => h('div.set-row', h('div.set-label', h('span', label), hint && h('small', hint)), h('div.set-control', control));

function renderSettings() {
  els.body.className = 'body settings';
  const tabs = [['account', 'user', '账号'], ['look', 'palette', '外观'], ['ai', 'sparkle', '阅读助手'], ['tts', 'headphones', '听书'], ['data', 'database', '存储与同步']];
  const content = { account: settingsAccount, look: settingsLook, ai: settingsAi, tts: settingsTts, data: settingsData }[view.settingsTab]();
  els.body.replaceChildren(
    h('nav.set-tabs', { role: 'tablist' }, tabs.map(([k, ic, t]) => h('button' + (view.settingsTab === k ? '.is-on' : ''), {
      type: 'button', role: 'tab', 'aria-selected': String(view.settingsTab === k), onclick: () => { view.settingsTab = k; renderBody(); },
    }, icon(ic, 18), t))),
    h('div.set-panel', content));
}

function settingsAccount() {
  const p = store.profile();
  const acct = store.account();
  const nickname = h('input.field', { type: 'text', value: p.nickname, maxLength: 40, 'aria-label': '昵称' });
  const hero = h('section.set-card.account-hero',
    h('button.avatar-edit', { type: 'button', 'aria-label': '更换头像', title: '更换头像', onclick: pickAvatar }, avatarEl(84), h('span.avatar-cam', icon('camera', 16))),
    h('div.account-id',
      h('form.inline-form', { onsubmit: (e) => { e.preventDefault(); guard(() => store.setNickname(nickname.value), '昵称已保存').then(renderAll); } },
        nickname, h('button.btn', { type: 'submit' }, '保存')),
      h('p.field-hint', acct ? `账号 ${p.username} · ${p.server}` : '现在是本机书库：书和记录只存在这台设备上。')));
  if (!acct) {
    return [hero, h('section.set-card',
      h('h2', '登录服务器'),
      h('p.field-hint', '登录后书、进度、划线批注和阅读时长会在每台设备之间同步。登录后可以把本机书库一起上传。'),
      loginForm({ onDone: afterSignIn }))];
  }
  return [hero,
    state.authLost && h('section.set-card.is-warn', h('h2', '登录已失效'), h('p.field-hint', '可能是在别处修改了密码。请重新登录。'), loginForm({ onDone: afterSignIn })),
    h('section.set-card',
      h('h2', '同步'),
      row('状态', h('span', state.online ? `已同步 · ${new Date(state.lastSync || Date.now()).toLocaleTimeString()}` : '离线')),
      row('立即同步', h('button.btn', { type: 'button', onclick: manualSync }, icon('sync', 18), '同步')),
      row('上传本机书库', h('button.btn', { type: 'button', onclick: async () => {
        const n = await store.localLibrarySize();
        if (!n) { toast('本机书库里没有书'); return; }
        afterSignIn();
      } }, icon('upload', 18), '上传'), '把登录前在这台设备上导入的书搬到账号里')),
    h('section.set-card',
      h('h2', '安全'),
      row('修改密码', h('button.btn', { type: 'button', onclick: changePasswordDialog }, icon('key', 18), '修改')),
      row('退出登录', h('button.btn.is-danger', { type: 'button', onclick: async () => {
        if (!await confirmDialog('退出登录', '这台设备会回到本机书库。账号里的书和记录都还在服务器上，下次登录就能看到。', { ok: '退出登录', danger: true })) return;
        await store.signOut(); coverCache.clear(); view.filter = 'all'; startShelf();
      } }, icon('logout', 18), '退出'), '回到本机书库'))];
}
function changePasswordDialog() {
  return dialog('修改密码', (close) => {
    const oldP = h('input.field', { type: 'password', autocomplete: 'current-password', required: true });
    const newP = h('input.field', { type: 'password', autocomplete: 'new-password', required: true, minLength: 6 });
    return h('form.dialog-body', { onsubmit: async (e) => { e.preventDefault(); if (await guard(() => store.changePassword(oldP.value, newP.value), '密码已修改')) close(); } },
      h('label.field-label', '原密码'), oldP, h('label.field-label', '新密码（至少 6 位）'), newP,
      h('div.dialog-actions', h('button.btn', { type: 'button', onclick: () => close() }, '取消'), h('button.btn.is-primary', { type: 'submit' }, '保存')));
  });
}

function settingsLook() {
  const redraw = () => renderBody();
  return [themeCard(), h('section.set-card',
    h('h2', '外观'),
    row('界面主题', segOf('界面主题', [['auto', '跟随系统'], ['light', '浅色'], ['dark', '深色']], prefs.get('theme', 'auto'), (v) => { prefs.set('theme', v); applyTheme(); redraw(); })),
    row('书架的查看方式', segOf('查看方式', [['shelf', '立体书架'], ['grid', '封面'], ['list', '列表']], view.layout, (v) => { view.layout = v; prefs.set('layout', v); redraw(); })),
    row('同系列的书叠成一本', segOf('叠放', [[true, '开'], [false, '关']], prefs.get('stack', true), (v) => { prefs.set('stack', v); redraw(); })),
    row('继续阅读浮条', segOf('浮条', [[true, '显示'], [false, '隐藏']], prefs.get('pill', true), (v) => { prefs.set('pill', v); document.body.classList.toggle('no-pill', !v); redraw(); }), '书架底部显示上次读到的书'))];
}

// 主题色：预设、自选、图片取色、跟随在读的书
function themeCard() {
  const a = theme.accentSettings();
  const current = a.mode === 'default' ? '' : a.color;
  const pick = (patch) => { theme.saveAccent(patch); renderBody(); };
  const drop = (id, name, color, on) => h('button.drop' + (on ? '.is-on' : ''), {
    type: 'button', 'aria-pressed': String(on), style: color ? `--d:${color}` : '', onclick: () => pick(id === 'default' ? { mode: 'default' } : { mode: 'preset', preset: id, color }),
  }, h('span.drop-dot' + (color ? '' : '.is-default')), h('span', name));
  const custom = h('input', { type: 'color', value: current || '#E46F93', 'aria-label': '自选颜色', onchange: (e) => pick({ mode: 'custom', color: e.target.value }) });
  const fromImage = h('input', { type: 'file', accept: 'image/*', hidden: true, onchange: async (e) => {
    const f = e.target.files[0]; if (!f) return;
    try { pick({ mode: 'image', color: await theme.extractColor(f) }); toast('已从图片取色'); } catch { toast('这张图片读不出来', { error: true }); }
  } });
  const sample = lastRead() || Object.values(state.books)[0];
  return h('section.set-card.theme-card',
    h('h2', '主题色'),
    h('p.field-hint', '选一个主色，背景、玻璃、按钮和书架会一起换成和它协调的色调，深色模式下也有对应的一套。阅读页的纸张配色不受影响。'),
    h('div.theme-preview', { 'aria-hidden': 'true' },
      h('div.tp-side', h('span.tp-nav.is-on'), h('span.tp-nav'), h('span.tp-nav')),
      h('div.tp-main',
        h('div.tp-head', h('b', '全部'), h('span.tp-btn', '导入')),
        h('div.tp-shelf', [0, 1, 2, 3, 4].map((i) => h('span.tp-book' + (i === 2 ? '.is-center' : ''), { style: `--i:${i - 2}` }))),
        h('div.tp-pill', h('span.tp-cover'), h('span.tp-lines', h('i'), h('i')), h('span.tp-ring')))),
    h('div.drops',
      drop('default', 'スス子', null, a.mode === 'default'),
      ...theme.PRESETS.map((p) => drop(p.id, p.name, p.color, a.mode === 'preset' && a.preset === p.id))),
    h('div.theme-more',
      h('label.btn', icon('palette', 18), '自选颜色', custom),
      h('button.btn', { type: 'button', onclick: () => fromImage.click() }, icon('camera', 18), '从图片取色'), fromImage,
      h('button.btn' + (a.mode === 'cover' ? '.is-primary' : ''), {
        type: 'button', disabled: !sample?.hasCover, title: sample?.hasCover ? '' : '书架上还没有带封面的书',
        onclick: async () => { if (a.mode === 'cover') { pick({ mode: 'default' }); return; } coverAccentFor = null; await syncCoverAccent(true); renderBody(); },
      }, icon('dict', 18), a.mode === 'cover' ? '正在跟随在读的书' : '跟随在读的书')),
    h('p.field-hint', a.mode === 'default' ? '当前：スス子默认配色' : `当前主色 ${current.toUpperCase()}${a.mode === 'cover' ? '，换一本书读时会跟着变' : ''}`));
}
/** “跟随在读的书”：用最近在读那本的封面取色 */
let coverAccentFor = null;
async function syncCoverAccent(force = false) {
  if (!force && theme.accentSettings().mode !== 'cover') return;
  const b = lastRead() || Object.values(state.books).find((x) => x.hasCover);
  if (!b?.hasCover || coverAccentFor === b.id + ':' + b.coverAt) return;
  coverAccentFor = b.id + ':' + b.coverAt;
  try {
    const url = await store.coverUrl(b);
    const img = new Image();
    img.src = url;
    await img.decode();
    theme.saveAccent({ mode: 'cover', color: await theme.extractColor(img) });
  } catch { coverAccentFor = null; }
}

function settingsAi() {
  const s = ai.aiSettings();
  const base = h('input.field', { type: 'url', value: s.base, placeholder: 'https://api.openai.com/v1' });
  const key = h('input.field', { type: 'password', value: s.key, placeholder: 'sk-…', autocomplete: 'off' });
  const model = h('input.field', { type: 'text', value: s.model, placeholder: '例如 gpt-4o-mini、deepseek-chat、qwen-plus' });
  const prompt = h('textarea.field.is-area', { value: s.prompt, rows: 6 });
  const result = h('p.field-hint', { role: 'status' });
  let target = s.target, via = s.viaServer;
  const saveAll = () => ai.saveAiSettings({ base: base.value.trim(), key: key.value.trim(), model: model.value.trim(), prompt: prompt.value.trim() || ai.DEFAULT_PROMPT, target, viaServer: via });
  for (const el of [base, key, model, prompt]) el.addEventListener('change', saveAll);
  const targetSeg = h('div');
  const drawTarget = () => targetSeg.replaceChildren(segOf('翻译成', ai.LANGUAGES.map((l) => [l, l]), target, (v) => { target = v; saveAll(); drawTarget(); }));
  drawTarget();
  const viaSeg = h('div');
  const drawVia = () => viaSeg.replaceChildren(segOf('经服务器转发', [[true, '开'], [false, '关']], via, (v) => { via = v; saveAll(); drawVia(); }));
  drawVia();
  return [
    h('section.set-card',
      h('h2', '接口'),
      h('p.field-hint', '查词、翻译和提问都用这里的接口。支持 OpenAI 兼容格式：OpenAI、DeepSeek、通义千问、Kimi、智谱、硅基流动、本地 Ollama 等。填的是到 /v1 为止的地址。'),
      h('label.field-label', '接口地址'), base,
      h('label.field-label', 'API Key'), key,
      h('label.field-label', '模型'), model,
      store.isConfigured() && row('经服务器转发', viaSeg, '有些接口不允许浏览器直接访问，打开后请求会经过你的服务器'),
      h('div.set-actions',
        h('button.btn', { type: 'button', onclick: async () => {
          saveAll(); result.textContent = '正在测试…';
          try { const t = await ai.chat([{ role: 'user', content: '用一句话打个招呼。' }]); result.textContent = `连接成功：${t.slice(0, 60)}`; }
          catch (e) { result.textContent = `连接失败：${e.message}`; }
        } }, '测试连接')),
      result,
      h('p.field-hint', 'API Key 只保存在这台设备上，不会上传到同步服务器（经服务器转发时只是临时经过）。')),
    h('section.set-card',
      h('h2', '翻译'),
      row('默认翻译成', targetSeg, '查词的解释也用这种语言')),
    h('section.set-card',
      h('h2', '助手提示词'),
      h('p.field-hint', '每次查词、翻译、提问前都会先告诉模型这段话，可以按自己的喜好改。'),
      prompt,
      h('div.set-actions', h('button.btn.is-quiet', { type: 'button', onclick: () => { prompt.value = ai.DEFAULT_PROMPT; saveAll(); toast('已恢复默认提示词'); } }, '恢复默认'))),
  ];
}

function settingsTts() {
  const t = ai.ttsSettings();
  const voiceSel = h('select.field', { 'aria-label': '声音' }, h('option', { value: '' }, '自动（按书的语言挑选）'));
  ai.systemVoices().then((voices) => {
    for (const v of voices.filter((x) => /^(zh|ja|en)/i.test(x.lang))) voiceSel.append(h('option', { value: v.voiceURI, selected: v.voiceURI === t.voice }, `${v.name}（${v.lang}）`));
    if (!voices.length) voiceSel.append(h('option', { disabled: true }, store.isNativeShell ? '使用系统默认的语音引擎' : '这个浏览器没有可用的声音'));
  });
  voiceSel.addEventListener('change', () => ai.saveTtsSettings({ voice: voiceSel.value }));
  const rate = h('input.reader-slider.is-plain', { type: 'range', min: 0.5, max: 2.5, step: 0.1, value: t.rate, 'aria-label': '语速' });
  const rateVal = h('span.range-value', `${t.rate.toFixed(1)} 倍`);
  const fill = () => rate.style.setProperty('--v', `${((rate.value - 0.5) / 2) * 100}%`);
  fill();
  rate.addEventListener('input', () => { rateVal.textContent = `${Number(rate.value).toFixed(1)} 倍`; fill(); });
  rate.addEventListener('change', () => ai.saveTtsSettings({ rate: Number(rate.value) }));
  const apiModel = h('input.field', { type: 'text', value: t.apiModel, placeholder: 'tts-1' });
  const apiVoice = h('input.field', { type: 'text', value: t.apiVoice, placeholder: 'alloy' });
  for (const [el, k] of [[apiModel, 'apiModel'], [apiVoice, 'apiVoice']]) el.addEventListener('change', () => ai.saveTtsSettings({ [k]: el.value.trim() }));
  return [h('section.set-card',
    h('h2', '听书'),
    h('p.field-hint', '在阅读时点“听书”，会从当前页开始一句一句朗读，读到哪里就高亮哪里，自动翻页、自动进下一章。'),
    row('朗读引擎', segOf('朗读引擎', [['system', '系统语音'], ['api', '接口语音']], t.engine, (v) => { ai.saveTtsSettings({ engine: v }); renderBody(); }),
      t.engine === 'api' ? '使用“阅读助手”里的接口地址和 Key，调用 /audio/speech' : '免费，不需要联网；音色取决于系统'),
    t.engine === 'system' ? row('声音', voiceSel) : [row('语音模型', apiModel), row('音色', apiVoice)],
    row('语速', h('div.range-inline', rate, rateVal)),
    h('div.set-actions', h('button.btn', { type: 'button', onclick: async () => {
      ai.stopSpeaking();
      try { await ai.speak('放学后的教室里只剩下我一个人。夕阳从窗户斜斜地照进来。'); } catch (e) { toast(e.message, { error: true }); }
    } }, icon('headphones', 18), '试听')))];
}

function settingsData() {
  const device = h('input.field', { type: 'text', value: store.deviceName(), maxLength: 40, onchange: () => prefs.set('device', device.value.trim()) });
  const usage = h('span', '计算中…');
  store.localUsage().then((n) => { usage.textContent = `约 ${fmtSize(n)}`; });
  return [h('section.set-card',
    h('h2', '存储与同步'),
    store.isConfigured() && row('阅读时顺便把整本存到本机', segOf('缓存', [[true, '开'], [false, '关']], prefs.get('autoCache', true), (v) => { prefs.set('autoCache', v); renderBody(); }), '关掉更省流量，想离线看的书可以多选后“下载到本机”'),
    row('这台设备的名字', device, '在别的设备上继续阅读时，会显示进度来自哪台设备'),
    h('dl.facts',
      h('dt', '书库'), h('dd', store.isConfigured() ? `账号 ${store.profile().username}` : '本机书库'),
      h('dt', '书架'), h('dd', `${Object.keys(state.books).length} 本书，${Object.keys(state.collections).length} 个合集`),
      h('dt', '已存在本机'), h('dd', `${state.downloaded.size} 本`),
      h('dt', '占用空间'), h('dd', usage)))];
}

// ---------- 导入 ----------
async function importFiles(files) {
  files = files.filter((f) => /\.(epub|cbz|zip)$/i.test(f.name));
  if (!files.length) { toast('只支持 EPUB 和 CBZ / ZIP 文件', { error: true }); return; }
  const into = state.collections[view.filter] ? [view.filter] : [];
  const t = toast('', { sticky: true });
  let ok = 0, dup = 0; const failed = [];
  for (const [i, file] of files.entries()) {
    t.update(`正在导入 ${i + 1} / ${files.length}：${file.name}`);
    try { const r = await store.importBook(file, into); if (r.duplicate) dup++; else ok++; }
    catch (e) { failed.push(`${file.name}（${e.message}）`); }
  }
  const parts = [];
  if (ok) parts.push(`已导入 ${ok} 本`);
  if (dup) parts.push(`${dup} 本已在书架上`);
  if (failed.length) parts.push(`失败：${failed.join('；')}`);
  t.done(parts.join('，'), !!failed.length);
}
let dragDepth = 0;
window.addEventListener('dragenter', (e) => {
  if (!els || !e.dataTransfer?.types.includes('Files')) return;
  dragDepth++; document.body.classList.add('is-dragging');
});
window.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; document.body.classList.remove('is-dragging'); } });
window.addEventListener('dragover', (e) => { if (e.dataTransfer?.types.includes('Files')) e.preventDefault(); });
window.addEventListener('drop', (e) => {
  if (!e.dataTransfer?.files.length) return;
  e.preventDefault(); dragDepth = 0; document.body.classList.remove('is-dragging');
  if (els && readerHost.hidden) importFiles([...e.dataTransfer.files]);
});

// ---------- 阅读器路由 ----------
// #/read/<书> 打开书；#/read/<书>/<记号> 打开并跳到某条划线 / 书签
function openBook(id, markId) { location.hash = `#/read/${id}${markId ? '/' + markId : ''}`; }
let reader = null, routeToken = 0, cameFromShelf = false;
function leaveReader() {
  if (cameFromShelf) history.back(); else location.hash = '#/';
}
async function route() {
  const token = ++routeToken;
  const m = /^#\/read\/([a-f0-9]+)(?:\/([a-f0-9]+))?$/.exec(location.hash);
  if (reader) { const r = reader; reader = null; store.stopReading(); await r.destroy(); store.flushNow(); }
  if (!m || !store.hasStarted()) {
    readerHost.hidden = true; readerHost.replaceChildren(); app.hidden = false;
    document.title = 'スス子文庫';
    cameFromShelf = true;
    renderAll();
    return;
  }
  const book = state.books[m[1]];
  if (!book) { toast('这本书已经不在书架上了', { error: true }); location.replace('#/'); return; }
  const jump = m[2] && state.marks[book.id]?.[m[2]];

  document.querySelectorAll('dialog[open]').forEach((d) => d.close());
  exitSelect(false);
  app.hidden = true; readerHost.hidden = false;
  document.title = store.seriesLabel(book);
  const note = h('p', '正在打开…');
  readerHost.replaceChildren(h('div.loading',
    h('button.icon-btn.loading-back', { type: 'button', 'aria-label': '返回书架', onclick: leaveReader }, icon('back')),
    h('h2', store.seriesLabel(book)), note));
  let handle = null;
  try {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const [got, fresh] = await Promise.all([
      store.bookSource(book),
      Promise.race([store.freshProgress(book.id), wait(2500).then(() => state.progress[book.id] || null)]),
    ]);
    handle = got;
    if (token !== routeToken) { handle.release(); return; }
    const progress = jump ? { loc: jump.loc, percent: jump.percent } : fresh;
    const mod = await (book.format === 'epub' ? import('./reader-epub.js') : import('./reader-comic.js'));
    const opened = await mod.open({ host: readerHost, book, title: store.seriesLabel(book), source: handle.source, progress, onExit: leaveReader, flash: jump?.id });
    if (token !== routeToken) { opened.destroy(); handle.release(); return; }
    reader = { destroy: async () => { await opened.destroy(); handle.release(); } };
    store.startReading(book.id);
    if (!jump && fresh && fresh.percent > 0 && fresh.device && fresh.device !== store.deviceName()) {
      toast(`已接上「${fresh.device}」的进度 ${fmtPercent(fresh.percent)}`);
    }
  } catch (e) {
    if (token !== routeToken) return;
    console.error(e);
    handle?.release();
    note.textContent = `打不开这本书：${e.message}`; note.classList.add('form-error');
  }
}
window.addEventListener('hashchange', route);

// ---------- 启动 ----------
store.onChange(() => { if (els && !app.hidden) renderAll(); });
function startShelf() {
  document.body.classList.toggle('no-pill', !prefs.get('pill', true));
  renderShelf();
  cameFromShelf = !location.hash.startsWith('#/read');
  route();
  store.sync().catch(() => {});
}
// 回到前台或恢复联网时自动同步
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && readerHost.hidden && store.isConfigured()) store.sync().catch(() => {});
});
window.addEventListener('online', () => store.sync().catch(() => {}));
// 窗口变窄后，书架旁边自动打开的详情要收起来（手机上它会盖住整个屏幕）
window.addEventListener('resize', () => { if (view.autoDetail && window.innerWidth <= 1180 && els) hideDetail(); });
// 阅读器里点“去设置”：回到书架后打开对应的设置页
window.addEventListener('open-settings', (e) => {
  view.settingsTab = e.detail || 'account';
  view.filter = 'settings';
  if (els) renderAll();
});
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && view.detail && readerHost.hidden && !document.querySelector('dialog[open]')) hideDetail();
  if (els?.shelf && readerHost.hidden && !document.querySelector('dialog[open]') && !e.target.closest?.('input, textarea, select, .shelf3d')) {
    if (e.key === 'ArrowRight') els.shelf.api.next(); else if (e.key === 'ArrowLeft') els.shelf.api.prev();
  }
});
(async () => {
  await store.init();
  if (!store.hasStarted()) { if (location.hash.startsWith('#/read')) history.replaceState(null, '', '#/'); renderWelcome(); return; }
  startShelf();
})();
