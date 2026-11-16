// 书架、合集、导入与路由。
import * as store from './store.js';
import { state, prefs } from './store.js';
import { h, icon, toast, dialog, confirmDialog, promptDialog, dropdown, fmtPercent, fmtSize, fmtDuration } from './ui.js';

const app = document.getElementById('app');
const readerHost = document.getElementById('reader');

const view = {
  filter: prefs.get('filter', 'all'), // all | reading | none | <合集 id>
  sort: prefs.get('sort', 'recent'),
  query: '',
  selecting: false,
  selected: new Set(),
};

// ---------- 主题 ----------
export function applyTheme() {
  const t = prefs.get('theme', 'auto');
  const dark = t === 'dark' || (t === 'auto' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
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

// ---------- 连接服务器 ----------
function renderSetup() {
  const url = h('input.field', {
    type: 'url', placeholder: 'https://books.example.com', autocomplete: 'url', required: true,
    value: store.isNativeShell || !/^https?:$/.test(location.protocol) ? '' : location.origin,
  });
  const key = h('input.field', { type: 'password', placeholder: '启动服务端时设置的 SHIORI_KEY', autocomplete: 'current-password', required: true });
  const error = h('p.form-error', { role: 'alert' });
  const submit = h('button.btn.is-primary.is-block', { type: 'submit' }, '连接');
  app.replaceChildren(h('main.setup',
    h('form.setup-card', {
      onsubmit: async (e) => {
        e.preventDefault();
        submit.disabled = true; submit.textContent = '正在连接…'; error.textContent = '';
        try { await store.connect(url.value, key.value); startShelf(); }
        catch (err) { error.textContent = err.message; submit.disabled = false; submit.textContent = '连接'; }
      },
    },
    h('div.brand.is-large', h('img.brand-icon', { src: 'icon-96.png', alt: '' }), h('span.brand-name', 'スス子文庫')),
    h('p.setup-lead', '连接你自己的服务器。书、合集和阅读进度都保存在那里，每台设备打开就是同一个书架。'),
    h('label.field-label', '服务器地址'), url,
    h('label.field-label', '访问密钥'), key,
    error, submit),
  ));
}

// ---------- 书架 ----------
let els = null;
const coverCache = new Map(); // 已解析好的封面地址，避免重绘闪烁

function booksIn(filter) {
  const all = Object.values(state.books);
  if (filter === 'all') return all;
  if (filter === 'reading' || filter === 'finished') return all.filter((b) => store.statusOf(b) === filter);
  if (filter === 'none') return all.filter((b) => !b.collections.length);
  if (filter === 'stats') return [];
  if (isSeries(filter)) return all.filter((b) => b.series === filter.slice(7));
  return all.filter((b) => b.collections.includes(filter));
}
const isSeries = (filter) => filter.startsWith('series:');
function filterName(filter) {
  if (isSeries(filter)) return filter.slice(7);
  return { all: '全部', reading: '在读', finished: '已读完', none: '未分类', stats: '阅读统计' }[filter] || state.collections[filter]?.name || '全部';
}
function openSeries(name) {
  if (!isSeries(view.filter)) view.back = view.filter;
  setFilter('series:' + name, true);
}
/** keepSelect：进出系列时保留多选状态，方便先找到书再勾选 */
function setFilter(filter, keepSelect = false) {
  view.filter = filter;
  if (!isSeries(filter)) prefs.set('filter', filter);
  if (!keepSelect) exitSelect(false);
  renderAll();
  els.main.scrollTop = 0;
}

function renderShelf() {
  const search = h('input.search-input', {
    type: 'search', placeholder: '搜索书名、作者、画师', 'aria-label': '搜索书名、作者、画师、出版社',
    oninput: () => { view.query = search.value.trim().toLowerCase(); renderGrid(); },
  });
  const sort = dropdown({
    label: '排序方式', value: view.sort, options: [['recent', '最近阅读'], ['added', '最近添加'], ['title', '按书名']],
    onChange: (v) => { view.sort = v; prefs.set('sort', v); renderGrid(); },
  });
  const fileInput = h('input', {
    type: 'file', multiple: true, hidden: true, accept: '.epub,.cbz,.zip,application/epub+zip,application/zip',
    onchange: () => { importFiles([...fileInput.files]); fileInput.value = ''; },
  });

  els = {
    nav: h('nav.side-nav', { 'aria-label': '书架分类' }),
    heading: h('div.heading'),
    grid: h('div.grid'),
    selectBtn: h('button.btn.is-quiet', { type: 'button', onclick: () => (view.selecting ? exitSelect() : enterSelect()) }, '选择'),
    syncBtn: h('button.icon-btn', { type: 'button', onclick: manualSync }),
    bar: h('div.select-bar', { hidden: true }),
    fileInput,
  };
  els.main = h('main.main',
    h('header.topbar',
      els.heading,
      h('div.tools',
        h('label.search', icon('search', 18), search),
        sort, els.selectBtn,
        h('button.btn.is-primary', { type: 'button', onclick: () => fileInput.click() }, icon('plus', 18), '导入'),
        els.syncBtn,
        h('button.icon-btn', { type: 'button', 'aria-label': '设置', title: '设置', onclick: openSettings }, icon('gear'))),
    ),
    els.grid, fileInput);

  app.replaceChildren(h('div.shell',
    h('aside.side', h('div.brand', h('img.brand-icon', { src: 'icon-96.png', alt: '' }), h('span.brand-name', 'スス子文庫')), els.nav),
    els.main, els.bar));
  renderAll();
}

function renderAll() {
  if (!els) return;
  if (isSeries(view.filter)) { if (!booksIn(view.filter).length) view.filter = view.back || 'all'; }
  else if (!['all', 'reading', 'finished', 'none', 'stats'].includes(view.filter) && !state.collections[view.filter]) view.filter = 'all';
  renderNav(); renderHeading(); renderGrid(); renderSync(); renderBar();
}

function renderNav() {
  const active = isSeries(view.filter) ? view.back || 'all' : view.filter;
  const item = (filter, iconName, label) => h('button.nav-item' + (active === filter ? '.is-active' : ''), {
    type: 'button', 'aria-current': active === filter ? 'page' : null, onclick: () => setFilter(filter),
  }, icon(iconName, 18), h('span.nav-label', label), h('span.nav-count', booksIn(filter).length));
  els.nav.replaceChildren(
    item('all', 'books', '全部'), item('reading', 'clock', '在读'), item('finished', 'check', '已读完'), item('none', 'inbox', '未分类'),
    h('div.nav-section', h('span', '合集'),
      h('button.icon-btn.is-small', { type: 'button', 'aria-label': '新建合集', title: '新建合集', onclick: newCollection }, icon('plus', 16))),
    ...store.sortedCollections().map((c) => item(c.id, 'folder', c.name)),
    h('button.nav-item.is-new', { type: 'button', onclick: newCollection }, icon('plus', 18), h('span.nav-label', '新建合集')),
    h('div.nav-section', h('span', '记录')),
    h('button.nav-item' + (active === 'stats' ? '.is-active' : ''), { type: 'button', onclick: () => setFilter('stats') },
      icon('chart', 18), h('span.nav-label', '阅读统计')),
  );
}

function renderHeading() {
  const isCollection = !!state.collections[view.filter];
  if (isSeries(view.filter)) {
    els.heading.replaceChildren(
      h('button.icon-btn', { type: 'button', 'aria-label': `返回「${filterName(view.back || 'all')}」`, onclick: () => setFilter(view.back || 'all', true) }, icon('back')),
      h('h1', filterName(view.filter)),
      h('span.heading-count', `${booksIn(view.filter).length} 卷`));
    return;
  }
  els.main.classList.toggle('is-stats', view.filter === 'stats');
  if (view.filter === 'stats') { els.heading.replaceChildren(h('h1', '阅读统计')); return; }
  els.heading.replaceChildren(
    h('h1', filterName(view.filter)),
    h('span.heading-count', `${booksIn(view.filter).length} 本`),
    ...(isCollection ? [h('button.icon-btn', { type: 'button', 'aria-label': '管理这个合集', title: '管理这个合集', onclick: manageCollection }, icon('more'))] : []),
  );
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

/** 同一系列叠成一本，点开看各卷 */
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

function bookCard(book) {
  const progress = state.progress[book.id]?.percent || 0;
  const status = store.statusOf(book);
  const selected = view.selected.has(book.id);
  const cover = coverOf(book);
  if (book.series && book.volume != null) cover.append(h('span.cover-vol', { 'aria-hidden': 'true' }, String(book.volume)));
  if (!state.downloaded.has(book.id)) cover.append(h('span.cover-badge', { title: '还没下载到这台设备，打开时边读边加载' }, icon('down', 14)));
  if (view.selecting) cover.append(h('span.cover-check' + (selected ? '.is-on' : ''), selected && icon('check', 16)));

  let pressTimer = null, longPressed = false;
  const card = h('button.book' + (selected ? '.is-selected' : ''), {
    type: 'button', 'aria-pressed': view.selecting ? String(selected) : null,
    title: [book.title, book.author && `作者：${book.author}`, book.illustrator && `插画：${book.illustrator}`,
      book.publisher && `出版社：${book.publisher}`, book.rating > 0 && `评分：${'★'.repeat(book.rating)}${'☆'.repeat(5 - book.rating)}`].filter(Boolean).join('\n'),
    onclick: () => {
      if (longPressed) { longPressed = false; return; }
      if (view.selecting) toggleSelect(book.id); else location.hash = '#/read/' + book.id;
    },
    oncontextmenu: (e) => { e.preventDefault(); if (!view.selecting) enterSelect(book.id); },
    onpointerdown: (e) => {
      if (e.pointerType === 'mouse' || view.selecting) return;
      longPressed = false;
      pressTimer = setTimeout(() => { longPressed = true; navigator.vibrate?.(10); enterSelect(book.id); }, 480);
    },
    onpointerup: () => clearTimeout(pressTimer),
    onpointercancel: () => clearTimeout(pressTimer),
    onpointermove: (e) => { if (Math.abs(e.movementX) + Math.abs(e.movementY) > 6) clearTimeout(pressTimer); },
  },
  cover,
  h('span.book-title', book.series ? (book.volume != null ? `${book.series} ${book.volume}` : book.series) : book.title),
  h('span.book-meta',
    h('span.book-author', book.author || (book.format === 'cbz' ? '漫画' : '')),
    status === 'finished' ? h('span.book-progress.is-done', '读完')
      : status === 'reading' && h('span.book-progress', progress > 0 ? fmtPercent(Math.min(progress, 0.99)) : '在读')),
  );
  return card;
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
    type: 'button', onclick: () => { view.statRange = n; renderGrid(); },
  }, `${n} 天`)));
  const fact = (value, unit, label) => h('div.fact', h('div.fact-value', String(value), h('small', unit)), h('div.fact-label', label));

  els.grid.className = 'stats';
  els.grid.replaceChildren(
    h('section.stat-hero',
      h('div',
        h('div.stat-caption', `近 ${range} 天的阅读时长`),
        h('div.stat-big', hours > 0 && [String(hours), h('small', '小时')], String(minutes), h('small', '分'))),
      seg),
    h('section.stat-facts',
      fact(perDay.filter(Boolean).length, '天', '有阅读的天数'),
      fact(ranked.length, '本', '读过的书'),
      fact(marks, '条', '书签与笔记')),
    h('section.stat-card', h('h2', range <= 30 ? '每天读了多久' : range === 90 ? '每周读了多久' : '每月读了多久'), bars(buckets, peak, buckets.length > 14 ? '.is-dense' : '')),
    h('section.stat-card', h('h2', '一周里哪天读得多'), bars(week, weekPeak)),
    h('section.stat-card', h('h2', '每本书读了多久'),
      ranked.length ? h('div.stat-books', ranked.slice(0, 30).map(([id, sec]) => h('button.stat-book', {
        type: 'button', title: '打开这本书', onclick: () => { location.hash = '#/read/' + id; },
      },
      h('span.stat-book-title', store.seriesLabel(state.books[id])),
      h('span.stat-book-time', fmtDuration(sec)),
      h('span.stat-book-bar', h('span', { style: `width:${Math.max(2, (sec / ranked[0][1]) * 100)}%` })))))
        : h('p.stat-empty', '这段时间还没有阅读记录。打开一本书读一会儿，这里就会有数据。')),
  );
}

function renderGrid() {
  if (view.filter === 'stats') { renderStats(); return; }
  const list = visibleBooks();
  if (list.length) {
    els.grid.className = 'grid';
    // 浏览时把同系列的书叠成一本；搜索、多选和系列页里逐本显示
    const stacking = prefs.get('stack', true) && !view.query && !isSeries(view.filter);
    const groups = new Map();
    if (stacking) for (const b of list) if (b.series) groups.set(b.series, [...(groups.get(b.series) || []), b]);
    const done = new Set();
    const cards = [];
    for (const b of list) {
      const group = stacking && b.series ? groups.get(b.series) : null;
      if (group && group.length > 1) { if (!done.has(b.series)) { done.add(b.series); cards.push(stackCard(b.series, group)); } }
      else cards.push(bookCard(b));
    }
    els.grid.replaceChildren(...cards);
    return;
  }
  els.grid.className = 'grid is-empty';
  let title, text, action = null;
  if (view.query) { title = `没有找到“${view.query}”`; text = '换个书名或作者试试。'; }
  else if (!Object.keys(state.books).length) {
    title = '书架还是空的'; text = '导入 EPUB 小说或 CBZ / ZIP 漫画，它们会出现在你的每台设备上。';
    action = h('button.btn.is-primary', { type: 'button', onclick: () => els.fileInput.click() }, icon('plus', 18), '导入第一本书');
  } else if (state.collections[view.filter]) { title = '这个合集还没有书'; text = '在书架上长按（或右键）一本书，选择“加入合集”。也可以直接在这里导入。'; }
  else if (view.filter === 'reading') { title = '没有正在读的书'; text = '打开任意一本书，它就会出现在这里。'; }
  else if (view.filter === 'finished') { title = '还没有读完的书'; text = '读到最后一页的书会自动出现在这里，也可以多选后手动标记。'; }
  else { title = '所有书都已归入合集'; text = ''; }
  els.grid.replaceChildren(h('div.empty', h('h2', title), text && h('p', text), action));
}

function renderSync() {
  const label = state.syncing ? '正在同步' : state.online ? '已同步，点击立即同步' : '离线，点击重试';
  els.syncBtn.replaceChildren(icon(state.online || state.syncing ? 'sync' : 'cloudOff'));
  els.syncBtn.className = 'icon-btn' + (state.syncing ? ' is-spinning' : '') + (!state.online && !state.syncing ? ' is-warn' : '');
  els.syncBtn.title = label; els.syncBtn.setAttribute('aria-label', label);
}
async function manualSync() {
  try { await store.sync(); toast('已同步'); } catch (e) { toast(e.message, { error: true }); }
}

// ---------- 多选 ----------
function enterSelect(id) {
  view.selecting = true; view.selected = new Set(id ? [id] : []);
  renderGrid(); renderBar();
}
function exitSelect(render = true) {
  view.selecting = false; view.selected.clear();
  if (render) { renderGrid(); renderBar(); }
}
function toggleSelect(id) {
  if (view.selected.has(id)) view.selected.delete(id); else view.selected.add(id);
  renderGrid(); renderBar();
}
function renderBar() {
  els.selectBtn.textContent = view.selecting ? '完成' : '选择';
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
      n === 1 ? act('信息与书评', ([id]) => editBook(id)) : act('设为系列', setSeries),
      act('标记状态', setStatus),
      ids.some((id) => !state.downloaded.has(id)) && act('下载到本机', downloadBooks),
      ids.some((id) => state.downloaded.has(id)) && act('移除本机副本', removeCopies),
      act('删除', deleteBooks, '.is-danger'),
      h('button.btn.is-quiet', { type: 'button', onclick: () => exitSelect() }, '完成')),
  );
}

async function guard(job, okMessage) {
  try { await job(); if (okMessage) toast(okMessage); return true; }
  catch (e) { toast(e.message || '操作失败', { error: true }); return false; }
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
      h('p.field-hint', `这 ${books.length} 本书会按书名里的数字编卷号；书名里没有数字的，按书名顺序从 1 开始。编错的可以单选一本，在“信息与书评”里改。`),
      h('div.dialog-actions',
        books.some((b) => b.series) && h('button.btn.is-danger', { type: 'button', onclick: () => apply('') }, '取消系列'),
        h('button.btn', { type: 'button', onclick: () => close() }, '取消'),
        h('button.btn.is-primary', { type: 'submit' }, '保存')));
  });
}

async function deleteBooks(ids) {
  const what = ids.length === 1 ? `《${state.books[ids[0]].title}》` : `这 ${ids.length} 本书`;
  if (!await confirmDialog('删除书籍', `${what}会从服务器和所有设备上删除，阅读进度也会一并清除。`, { ok: '删除', danger: true })) return;
  const ok = await guard(async () => { for (const id of ids) await store.deleteBook(id); }, '已删除');
  if (ok) exitSelect();
}
function editBook(id) {
  const book = state.books[id];
  return dialog('书籍信息', (close) => {
    const title = h('input.field', { type: 'text', value: book.title, maxLength: 200, required: true });
    const author = h('input.field', { type: 'text', value: book.author, maxLength: 200 });
    const illustrator = h('input.field', { type: 'text', value: book.illustrator || '', maxLength: 200 });
    const publisher = h('input.field', { type: 'text', value: book.publisher || '', maxLength: 200, placeholder: '例如：电击文库' });
    const review = h('textarea.field.is-area', { value: book.review || '', maxLength: 5000, rows: 4, placeholder: '读完有什么想说的？' });
    let rating = book.rating || 0;
    const stars = h('div.stars', { role: 'group', 'aria-label': '评分' });
    const drawStars = () => stars.replaceChildren(...[1, 2, 3, 4, 5].map((n) => h('button' + (n <= rating ? '.is-on' : ''), {
      type: 'button', 'aria-label': `${n} 星`, 'aria-pressed': String(n <= rating), onclick: () => { rating = rating === n ? 0 : n; drawStars(); },
    }, icon(n <= rating ? 'starOn' : 'star', 26))));
    drawStars();
    const read = store.secondsOf(id), markCount = store.marksOf(id).length;
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
          rating, review: review.value.trim(),
          series: series.value.trim(), volume: volume.value === '' ? null : Number(volume.value),
        };
        if (await guard(() => store.updateBook(id, patch), '已保存')) { close(); exitSelect(); }
      },
    },
    h('label.field-label', '书名'), title,
    h('div.field-pair.is-even',
      h('div', h('label.field-label', '作者'), author),
      h('div', h('label.field-label', '插画'), illustrator)),
    h('label.field-label', '出版社'), publisher,
    h('label.field-label', '阅读状态'), statusSeg,
    h('div.field-pair',
      h('div', h('label.field-label', '系列'), series),
      h('div', h('label.field-label', '卷号'), volume)),
    h('datalist', { id: 'series-names' }, names.map((n) => h('option', { value: n }))),
    h('p.field-hint', '填了系列和卷号，书架上会显示成“系列名 + 卷号”，同系列的书会叠在一起并按卷号排序。'),
    h('label.field-label', '我的评分'), stars,
    h('label.field-label', '书评'), review,
    h('p.field-hint', `累计阅读 ${fmtDuration(read)}，${markCount} 条书签与笔记。`),
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

// ---------- 设置 ----------
function openSettings() {
  return dialog('设置', (close) => {
    const conf = store.server();
    const device = h('input.field', { type: 'text', value: store.deviceName(), maxLength: 40, onchange: () => prefs.set('device', device.value.trim()) });
    const themes = [['auto', '跟随系统'], ['light', '浅色'], ['dark', '深色']];
    const seg = h('div.segmented', { role: 'group', 'aria-label': '界面主题' });
    const drawSeg = () => seg.replaceChildren(...themes.map(([v, label]) => h('button' + (prefs.get('theme', 'auto') === v ? '.is-on' : ''), {
      type: 'button', onclick: () => { prefs.set('theme', v); applyTheme(); drawSeg(); },
    }, label)));
    drawSeg();
    const usage = h('span', '计算中…');
    store.localUsage().then((n) => { usage.textContent = `${state.downloaded.size} 本书，约 ${fmtSize(n)}`; });
    const toggle = (key, label) => {
      const el = h('div.segmented', { role: 'group', 'aria-label': label });
      const draw = () => el.replaceChildren(...[[true, '开'], [false, '关']].map(([v, text]) => h('button' + (prefs.get(key, true) === v ? '.is-on' : ''), {
        type: 'button', onclick: () => { prefs.set(key, v); draw(); renderGrid(); },
      }, text)));
      draw();
      return h('div.setting-row', h('span', label), el);
    };
    return h('div.dialog-body',
      h('label.field-label', '界面主题'), seg,
      toggle('stack', '同系列的书叠成一本'),
      toggle('autoCache', '阅读时顺便把整本存到本机'),
      h('p.field-hint', '关掉后只加载正在读的部分，更省流量；想离线看的书可以在多选里点“下载到本机”。'),
      h('label.field-label', '这台设备的名字'), device,
      h('p.field-hint', '在别的设备上继续阅读时，会显示进度来自哪台设备。'),
      h('dl.facts',
        h('dt', '服务器'), h('dd', conf.url),
        h('dt', '书架'), h('dd', `${Object.keys(state.books).length} 本书，${Object.keys(state.collections).length} 个合集`),
        h('dt', '已下载到本机'), h('dd', usage)),
      h('div.dialog-actions',
        h('button.btn.is-danger', {
          type: 'button',
          onclick: async () => {
            if (!await confirmDialog('断开连接', '会清除这台设备上的缓存和登录信息。服务器上的书和进度不受影响。', { ok: '断开连接', danger: true })) return;
            await store.flushNow(); await store.disconnect(); close(); els = null; renderSetup();
          },
        }, '断开连接'),
        h('button.btn.is-primary', { type: 'button', onclick: () => close() }, '完成')));
  });
}

// ---------- 阅读器路由 ----------
let reader = null, routeToken = 0, cameFromShelf = false;
function leaveReader() {
  if (cameFromShelf) history.back(); else location.hash = '#/';
}
async function route() {
  const token = ++routeToken;
  const m = /^#\/read\/([a-f0-9]+)$/.exec(location.hash);
  if (reader) { const r = reader; reader = null; store.stopReading(); await r.destroy(); store.flushNow(); }
  if (!m || !store.isConfigured()) {
    readerHost.hidden = true; readerHost.replaceChildren(); app.hidden = false;
    document.title = 'スス子文庫';
    cameFromShelf = true;
    renderAll();
    return;
  }
  const book = state.books[m[1]];
  if (!book) { toast('这本书已经不在书架上了', { error: true }); location.replace('#/'); return; }

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
    const [got, progress] = await Promise.all([
      store.bookSource(book),
      Promise.race([store.freshProgress(book.id), wait(2500).then(() => state.progress[book.id] || null)]),
    ]);
    handle = got;
    if (token !== routeToken) { handle.release(); return; }
    const mod = await (book.format === 'epub' ? import('./reader-epub.js') : import('./reader-comic.js'));
    const opened = await mod.open({ host: readerHost, book, title: store.seriesLabel(book), source: handle.source, progress, onExit: leaveReader });
    if (token !== routeToken) { opened.destroy(); handle.release(); return; }
    reader = { destroy: async () => { await opened.destroy(); handle.release(); } };
    store.startReading(book.id);
    if (progress && progress.percent > 0 && progress.device && progress.device !== store.deviceName()) {
      toast(`已接上「${progress.device}」的进度 ${fmtPercent(progress.percent)}`);
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
(async () => {
  await store.init();
  if (!store.isConfigured()) { if (location.hash.startsWith('#/read')) history.replaceState(null, '', '#/'); renderSetup(); return; }
  startShelf();
})();
