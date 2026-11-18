// 漫画阅读器：CBZ / ZIP。翻页（可日漫右翻、宽屏双页）或下拉长条。
import { ZipReader, mimeOf, isImageName } from './zip.js';
import { prefs, setProgress, natural } from './store.js';
import { h, icon, toast, menuButton, statusClock } from './ui.js';

const DEFAULTS = { mode: 'page', rtl: true, spread: true };

export async function open({ host, book, title = book.title, source, progress, onExit }) {
  // 网盘里的图片文件夹本身就是一页一张图；压缩包则从里面挑出图片
  const zip = source.isPageList ? source : await ZipReader.open(source);
  const entries = zip.entries.filter((e) => !e.isDir && isImageName(e.name)).sort((a, b) => natural(a.name, b.name));
  if (!entries.length) throw new Error(source.isPageList ? '这个文件夹里没有图片' : '压缩包里没有图片');
  const total = entries.length;
  // 本机文件读得快，预读两页就够；从服务器或网盘取的要多预读几页，翻页时才不用等
  const remote = !(source instanceof Blob);
  const AHEAD = remote ? 5 : 2;
  const settings = { ...DEFAULTS, ...prefs.get('comic', {}) };
  let page = Math.min(total - 1, Math.max(0, Number(progress?.loc?.page) || 0));
  let destroyed = false, cleanupView = () => {};

  // ---------- 图片缓存 ----------
  const urls = new Map();
  function urlOf(i) {
    if (!urls.has(i)) urls.set(i, zip.blobOf(entries[i], mimeOf(entries[i].name)).then((b) => URL.createObjectURL(b)));
    return urls.get(i);
  }
  function evict(keepAround, radius) {
    for (const [i, p] of urls) {
      if (Math.abs(i - keepAround) > radius) { urls.delete(i); p.then((u) => URL.revokeObjectURL(u)).catch(() => {}); }
    }
  }

  // ---------- 结构 ----------
  const stage = h('div.reader-stage');
  const footRight = h('span.foot-page');
  const slider = h('input.reader-slider', { type: 'range', min: 1, max: total, step: 1, 'aria-label': '页码' });
  const sliderLabel = h('span.dock-percent');
  const topSub = h('span.reader-sub');
  const fill = () => slider.style.setProperty('--v', `${total > 1 ? ((slider.value - 1) / (total - 1)) * 100 : 100}%`);
  const sheet = h('div.reader-sheet', { hidden: true });
  const scrim = h('div.reader-scrim', { hidden: true, onclick: closePanels });
  const clock = statusClock();
  const modeBtn = menuButton('scroll', '下拉', () => { toggleChrome(false); change({ mode: settings.mode === 'scroll' ? 'page' : 'scroll' }); });
  const drawModeBtn = () => modeBtn.replaceChildren(
    icon(settings.mode === 'scroll' ? 'pages' : 'scroll', 22), h('span', settings.mode === 'scroll' ? '改为翻页' : '改为下拉'));
  drawModeBtn();
  const root = h('div.reader.is-comic', { 'data-dark': 'true' },
    stage,
    h('footer.reader-foot', clock.el, h('span.foot-chapter', title), footRight),
    h('header.reader-top',
      h('button.icon-btn', { type: 'button', 'aria-label': '返回书架', onclick: onExit }, icon('back')),
      h('div.reader-heading', h('span.reader-title', title), topSub)),
    h('div.reader-bottom',
      h('div.dock-info', h('span.dock-chapter', '页码'), sliderLabel),
      h('div.bottom-row', slider),
      h('div.bottom-actions', modeBtn, menuButton('gear', '设置', openSheet))),
    scrim, sheet);
  root.style.setProperty('--paper', '#101114');
  root.style.setProperty('--paper-ink', '#C9CED9');
  root.style.setProperty('--paper-accent', '#F283A8');
  host.replaceChildren(root);

  const chromeOpen = () => root.classList.contains('is-chrome');
  const toggleChrome = (on = !chromeOpen()) => root.classList.toggle('is-chrome', on);
  function closePanels() { sheet.hidden = true; scrim.hidden = true; }
  function openSheet() { toggleChrome(false); drawSheet(); sheet.hidden = false; scrim.hidden = false; }

  function report(lastShown = page, save = true) {
    footRight.textContent = `${lastShown + 1} / ${total}`;
    slider.value = lastShown + 1; fill();
    sliderLabel.textContent = `${lastShown + 1} / ${total}`;
    topSub.textContent = `第 ${lastShown + 1} / ${total} 页`;
    if (save) setProgress(book.id, { page }, (lastShown + 1) / total);
  }

  // ---------- 翻页模式 ----------
  function mountPaged(save) {
    const holder = h('div.comic-page');
    const touch = h('div.reader-touch');
    stage.replaceChildren(holder, touch);
    let token = 0, shown = -1;
    const calm = matchMedia('(prefers-reduced-motion: reduce)').matches;

    const spread = () => settings.spread && stage.clientWidth > stage.clientHeight * 1.15;
    function group(p) { // 当前画面显示哪几页：封面单独一页，其后两两成对
      if (!spread() || p === 0) return [p];
      const first = p % 2 ? p : p - 1;
      return first + 1 < total ? [first, first + 1] : [first];
    }
    async function render(saveNow = true) {
      const t = ++token;
      const g = group(page);
      page = g[0];
      for (let i = g[g.length - 1] + 1; i <= Math.min(total - 1, g[g.length - 1] + AHEAD); i++) urlOf(i); // 先把后面几页排上队
      // 这一页还没取到时，过一小会儿显示“正在加载”，不让画面看起来卡住
      const wait = setTimeout(() => { if (t === token) holder.classList.add('is-loading'); }, 150);
      const srcs = await Promise.all(g.map(urlOf)).catch(() => null);
      if (t !== token || destroyed) { clearTimeout(wait); return; }
      if (!srcs) { clearTimeout(wait); holder.classList.remove('is-loading'); toast('这一页读不出来，可能是网络断了', { error: true }); return; }
      const imgs = srcs.map((src, n) => h('img', { src, alt: `第 ${g[n] + 1} 页`, draggable: false }));
      await Promise.all(imgs.map((im) => im.decode().catch(() => {}))); // 先在后台解码好大图，换页时就不会顿一下
      clearTimeout(wait);
      if (t !== token || destroyed) return;
      holder.classList.remove('is-loading');
      holder.classList.toggle('is-rtl', settings.rtl);
      holder.replaceChildren(...imgs);
      const turn = prefs.get('reader', {}).turn || 'slide'; // 和小说共用“翻页动画”设置
      if (shown >= 0 && shown !== page && !calm && turn !== 'none') {
        const from = (page > shown ? 1 : -1) * (settings.rtl ? -1 : 1); // 新的一页从哪一侧进来
        holder.animate([{ opacity: 0.2, transform: `translateX(${turn === 'slide' ? from * 9 : 0}%)` }, { opacity: 1, transform: 'none' }], { duration: 220, easing: 'ease-out' });
      }
      shown = page;
      report(g[g.length - 1], saveNow);
      const last = g[g.length - 1];
      if (g[0] > 0) urlOf(g[0] - 1); // 往回翻一页也常见
      evict(page, AHEAD + 6);
    }
    function next() {
      const g = group(page);
      if (g[g.length - 1] >= total - 1) { toast('已经是最后一页了'); return; }
      page = g[g.length - 1] + 1; render();
    }
    function prev() { if (page > 0) { page -= 1; render(); } }
    const leftward = () => (settings.rtl ? next() : prev());
    const rightward = () => (settings.rtl ? prev() : next());

    let down = null;
    touch.addEventListener('pointerdown', (e) => { down = { x: e.clientX, y: e.clientY }; });
    touch.addEventListener('pointerup', (e) => {
      if (!down) return;
      const dx = e.clientX - down.x, dy = e.clientY - down.y;
      down = null;
      if (Math.abs(dx) > 40 && Math.abs(dx) > Math.abs(dy) * 1.5) {
        toggleChrome(false);
        // 手指往哪边拖，就把那一侧的反方向页面拉进来
        if (dx > 0) leftward(); else rightward();
        return;
      }
      if (Math.abs(dx) + Math.abs(dy) > 12) return;
      if (chromeOpen()) { toggleChrome(false); return; }
      const rect = touch.getBoundingClientRect();
      const x = (e.clientX - rect.left) / rect.width;
      if (x < 0.3) leftward(); else if (x > 0.7) rightward(); else toggleChrome(true);
    });
    let lastWheel = 0;
    touch.addEventListener('wheel', (e) => {
      e.preventDefault();
      const now = Date.now();
      if (now - lastWheel < 220 || Math.abs(e.deltaY) < 4) return;
      lastWheel = now;
      if (e.deltaY > 0) next(); else prev();
    }, { passive: false });

    const onKey = (key) => {
      if (key === 'ArrowLeft') leftward();
      else if (key === 'ArrowRight') rightward();
      else if ([' ', 'PageDown', 'ArrowDown'].includes(key)) next();
      else if (['PageUp', 'ArrowUp'].includes(key)) prev();
      else return false;
      return true;
    };
    let wasSpread = spread();
    const observer = new ResizeObserver(() => { if (spread() !== wasSpread) { wasSpread = spread(); render(false); } });
    observer.observe(stage);
    render(save);
    return { goto: (p) => { page = p; render(); }, onKey, cleanup: () => observer.disconnect() };
  }

  // ---------- 下拉模式 ----------
  function mountScroll(save) {
    const scroller = h('div.comic-scroll');
    const items = entries.map((_, i) => h('div.comic-strip', { 'data-i': i }));
    scroller.append(...items);
    stage.replaceChildren(scroller);

    const loader = new IntersectionObserver((list) => {
      for (const entry of list) {
        const el = entry.target, i = Number(el.dataset.i);
        if (entry.isIntersecting && !el.firstChild) {
          urlOf(i).then((src) => {
            if (destroyed || el.firstChild) return;
            const img = h('img', { src, alt: `第 ${i + 1} 页`, draggable: false });
            img.addEventListener('load', () => { el.style.aspectRatio = `${img.naturalWidth} / ${img.naturalHeight}`; }, { once: true });
            el.append(img);
          }).catch(() => {});
        }
      }
    }, { root: scroller, rootMargin: remote ? '400% 0px' : '150% 0px' });
    items.forEach((el) => loader.observe(el));

    let ticking = false;
    function track() {
      ticking = false;
      const mid = scroller.scrollTop + scroller.clientHeight * 0.4;
      let lo = 0, hi = total - 1;
      while (lo < hi) { // 二分找到视口里的那一页
        const m = (lo + hi) >> 1;
        if (items[m].offsetTop + items[m].offsetHeight < mid) lo = m + 1; else hi = m;
      }
      const atEnd = scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 4;
      const now = atEnd ? total - 1 : lo;
      if (now !== page) {
        page = now; report(page);
        for (const [i] of urls) { // 离得远的页释放内存，保留占位高度
          if (Math.abs(i - page) > 8 && items[i].firstChild) items[i].replaceChildren();
        }
        evict(page, 8);
      }
    }
    scroller.addEventListener('scroll', () => { if (!ticking) { ticking = true; requestAnimationFrame(track); } }, { passive: true });
    let down = null;
    scroller.addEventListener('pointerdown', (e) => { down = { x: e.clientX, y: e.clientY }; });
    scroller.addEventListener('click', (e) => {
      if (down && Math.abs(e.clientX - down.x) + Math.abs(e.clientY - down.y) < 10) toggleChrome();
    });

    const jump = (p) => { items[p].scrollIntoView({ block: 'start' }); };
    requestAnimationFrame(() => { if (page > 0) jump(page); report(page, save); });
    const step = (dir) => scroller.scrollBy({ top: dir * scroller.clientHeight * 0.85, behavior: 'smooth' });
    const onKey = (key) => {
      if ([' ', 'PageDown', 'ArrowDown', 'ArrowRight'].includes(key)) step(1);
      else if (['PageUp', 'ArrowUp', 'ArrowLeft'].includes(key)) step(-1);
      else return false;
      return true;
    };
    return { goto: (p) => { page = p; jump(p); report(p); }, onKey, cleanup: () => loader.disconnect() };
  }

  let viewApi = null;
  function mount(save = false) {
    cleanupView();
    viewApi = settings.mode === 'scroll' ? mountScroll(save) : mountPaged(save);
    cleanupView = viewApi.cleanup;
  }

  // ---------- 通用操作 ----------
  function onKey(e) {
    if (document.querySelector('dialog[open]')) return;
    if (e.key === 'Escape') { if (!scrim.hidden) closePanels(); else if (chromeOpen()) toggleChrome(false); else onExit(); return; }
    if (!scrim.hidden || e.target === slider) return;
    if (viewApi.onKey(e.key)) e.preventDefault();
  }
  window.addEventListener('keydown', onKey);
  // 安卓音量键翻页
  const onVolume = (e) => { if (scrim.hidden) viewApi.onKey(e.detail === 'down' ? 'PageDown' : 'PageUp'); };
  const volumeOn = prefs.get('reader', {}).volumeKeys !== false;
  window.addEventListener('volumekey', onVolume);
  try { window.SusukoNative?.setVolumeKeys(volumeOn); } catch { /* 网页版没有原生层 */ }
  slider.addEventListener('input', () => { sliderLabel.textContent = `${slider.value} / ${total}`; fill(); });
  slider.addEventListener('change', () => viewApi.goto(Number(slider.value) - 1));

  function change(patch) {
    Object.assign(settings, patch);
    prefs.set('comic', settings);
    mount(); drawSheet(); drawModeBtn();
  }
  function drawSheet() {
    const seg = (label, key, options) => h('div.sheet-row', h('span.sheet-label', label),
      h('div.segmented', { role: 'group', 'aria-label': label }, options.map(([value, text]) => h('button' + (settings[key] === value ? '.is-on' : ''), {
        type: 'button', onclick: () => change({ [key]: value }),
      }, text))));
    const rows = [seg('阅读方式', 'mode', [['page', '翻页'], ['scroll', '下拉']])];
    if (settings.mode === 'page') {
      rows.push(seg('翻页方向', 'rtl', [[true, '从右到左（日漫）'], [false, '从左到右']]),
        seg('宽屏双页', 'spread', [[true, '开'], [false, '关']]));
    }
    sheet.replaceChildren(
      h('div.sheet-head', h('h2', '阅读设置'),
        h('button.icon-btn', { type: 'button', 'aria-label': '关闭', onclick: closePanels }, icon('close'))),
      h('div.sheet-body', rows));
  }

  mount(false);

  return {
    async destroy() {
      destroyed = true;
      cleanupView(); clock.stop();
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('volumekey', onVolume);
      try { window.SusukoNative?.setVolumeKeys(false); } catch { /* 忽略 */ }
      root.remove();
      evict(-1e9, 0);
    },
  };
}
