// EPUB 阅读器：横排。可左右翻页（CSS 多栏分页，宽屏双页，带翻页动画），也可上下滚动。
import { Epub } from './epub.js';
import { prefs, setProgress } from './store.js';
import { h, icon, toast, menuButton, imageViewer } from './ui.js';

export const PAPERS = {
  white: { name: '白', bg: '#FFFFFF', fg: '#20242E', accent: '#C2255C', dark: false },
  paper: { name: '纸', bg: '#F3EEE2', fg: '#3A342A', accent: '#A8324F', dark: false },
  grey: { name: '灰', bg: '#E4E8EE', fg: '#262B36', accent: '#C2255C', dark: false },
  night: { name: '夜', bg: '#15171C', fg: '#B9BFCC', accent: '#F283A8', dark: true },
};
const FONTS = {
  book: { name: '原书', css: null },
  hei: { name: '黑体', css: '"PingFang SC","HarmonyOS Sans SC","Microsoft YaHei UI","Microsoft YaHei","Noto Sans CJK SC","Noto Sans SC",sans-serif' },
  ming: { name: '宋体', css: '"Source Han Serif SC","Noto Serif CJK SC","Noto Serif SC","Songti SC","Yu Mincho","SimSun",serif' },
};
const DEFAULTS = { fontSize: 18, lineHeight: 1.8, margin: 1, font: 'book', paper: 'white', spread: true, flow: 'paged', turn: 'slide' };
export const readerSettings = () => ({ ...DEFAULTS, ...prefs.get('reader', {}) });

export async function open({ host, book, title = book.title, source, progress, onExit }) {
  const epub = await Epub.open(source);
  const settings = readerSettings();
  let index = 0, page = 0, pages = 1, W = 0, H = 0, loadToken = 0, destroyed = false, busy = false;
  const isScroll = () => settings.flow === 'scroll';
  const calm = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const turnStyle = () => (calm ? 'none' : settings.turn);

  // ---------- 结构 ----------
  const frame = h('iframe.reader-frame', { sandbox: 'allow-same-origin', title, tabIndex: -1 });
  const touch = h('div.reader-touch');
  const footLeft = h('span.foot-chapter');
  const footRight = h('span.foot-page');
  const slider = h('input.reader-slider', { type: 'range', min: 0, max: 1000, step: 1, 'aria-label': '全书进度' });
  const dockChapter = h('span.dock-chapter');
  const dockPercent = h('span.dock-percent');
  const topSub = h('span.reader-sub');
  const tocList = h('div.toc-list');
  const sheet = h('div.reader-sheet', { hidden: true });
  const toc = h('aside.reader-toc', { hidden: true }, h('h2', '目录'), tocList);
  const scrim = h('div.reader-scrim', { hidden: true, onclick: closePanels });
  // 底部菜单：点一下屏幕中间弹出，拇指就能够到
  const nightBtn = menuButton('moon', '夜间', toggleNight);
  const actions = h('div.bottom-actions',
    menuButton('list', '目录', () => openPanel(toc)),
    nightBtn,
    menuButton('type', '排版', () => openPanel(sheet)));
  const root = h('div.reader',
    h('div.reader-stage', frame, touch),
    h('footer.reader-foot', footLeft, footRight),
    h('header.reader-top',
      h('button.icon-btn', { type: 'button', 'aria-label': '返回书架', onclick: onExit }, icon('back')),
      h('div.reader-heading', h('span.reader-title', title), topSub)),
    h('div.reader-bottom',
      h('div.dock-info', dockChapter, dockPercent),
      h('div.bottom-row',
        h('button.icon-btn', { type: 'button', 'aria-label': '上一章', title: '上一章', onclick: () => { if (index > 0) load(index - 1, {}, true, -1); } }, icon('prev')),
        slider,
        h('button.icon-btn', { type: 'button', 'aria-label': '下一章', title: '下一章', onclick: () => { if (index < epub.spine.length - 1) load(index + 1, {}, true, 1); } }, icon('next'))),
      actions),
    scrim, toc, sheet);
  host.replaceChildren(root);
  applyPaper();

  function applyPaper() {
    const p = PAPERS[settings.paper] || PAPERS.white;
    root.style.setProperty('--paper', p.bg);
    root.style.setProperty('--paper-ink', p.fg);
    root.style.setProperty('--paper-accent', p.accent);
    root.dataset.dark = String(p.dark);
    root.classList.toggle('is-scroll', isScroll());
    nightBtn.replaceChildren(icon(p.dark ? 'sun' : 'moon', 22), h('span', p.dark ? '日间' : '夜间'));
  }
  function toggleNight() {
    if (settings.paper === 'night') change({ paper: settings.dayPaper || 'white' });
    else change({ dayPaper: settings.paper, paper: 'night' });
  }

  // ---------- 排版 ----------
  function buildCss() {
    const stage = frame.parentElement;
    W = Math.max(200, Math.floor(stage.clientWidth));
    H = Math.max(200, Math.floor(stage.clientHeight));
    const wide = W >= 700;
    const cols = !isScroll() && settings.spread && W >= 1000 && W > H * 1.15 ? 2 : 1;
    let padH = (wide ? [32, 56, 88] : [14, 24, 38])[settings.margin];
    if (cols === 1) padH = Math.max(padH, Math.round((W - 780) / 2));
    const gap = padH * 2;
    const colW = (W - padH * 2 - (cols - 1) * gap) / cols;
    const padV = wide ? 36 : 22;
    const p = PAPERS[settings.paper] || PAPERS.white;
    const font = FONTS[settings.font] || FONTS.book;
    const root0 = `margin:0!important;padding:0!important;background:${p.bg}!important;font-size:${settings.fontSize}px!important;-webkit-text-size-adjust:100%!important`;
    const text = `background:transparent!important;color:${p.fg}!important;font-size:1rem!important;line-height:${settings.lineHeight}!important;font-family:${FONTS.hei.css};
text-align:justify;overflow-wrap:break-word;line-break:strict;-webkit-user-select:none;user-select:none`;
    const layout = isScroll() ? `
html{${root0};width:auto!important;height:auto!important;overflow-x:hidden!important;overflow-y:auto!important;scrollbar-width:thin}
body{margin:0!important;padding:${padV}px ${padH}px 48px!important;box-sizing:border-box!important;width:auto!important;height:auto!important;max-width:none!important;min-width:0!important;columns:auto!important;overflow:visible!important;
${text}}
img,svg,video{max-width:100%!important;max-height:${H}px!important;height:auto;object-fit:contain}
.shiori-nav{display:block;margin:2.2em 0 .6em;padding:15px;border-radius:14px;text-align:center;text-indent:0;font-size:14px;line-height:1.4;cursor:pointer;background:color-mix(in srgb,${p.fg} 8%,transparent)}
.shiori-nav[data-shiori-nav="prev"]{margin:0 0 1.6em}` : `
html{${root0};width:${W}px!important;height:${H}px!important;overflow:hidden!important}
body{margin:0!important;padding:${padV}px ${padH}px!important;box-sizing:border-box!important;width:${W}px!important;height:${H}px!important;max-width:none!important;min-width:0!important;
column-width:${colW}px!important;column-gap:${gap}px!important;column-fill:auto!important;column-rule:none!important;overflow:visible!important;
${text}}
img,svg,video{max-width:100%!important;max-height:${H - padV * 2}px!important;object-fit:contain;break-inside:avoid!important}
.shiori-nav{display:none!important}`;
    return `${layout}
*{writing-mode:horizontal-tb!important;text-combine-upright:none!important}
p,li,dd,blockquote{line-height:inherit!important;orphans:1;widows:1}
a{color:${p.accent}!important;text-decoration:none!important}
${settings.paper === 'white' ? '' : `body *{color:inherit!important;background-color:transparent!important;border-color:currentColor!important}body a{color:${p.accent}!important}`}
${font.css ? `body,body *{font-family:${font.css}!important}` : ''}`;
  }

  const frameDoc = () => frame.contentDocument;
  const scroller = () => frameDoc()?.documentElement;
  function measure() {
    const el = scroller();
    if (el && !isScroll()) pages = Math.max(1, Math.ceil((el.scrollWidth - 2) / W));
  }
  /** 本章内的位置 0~1（页或滚动位置的起点） */
  function fractionNow() {
    if (!isScroll()) return page / pages;
    const el = scroller();
    return el && el.scrollHeight > 0 ? el.scrollTop / el.scrollHeight : 0;
  }
  function refresh(save = true) { // 更新页脚、进度条，并记录进度
    let end, where;
    if (isScroll()) {
      const el = scroller();
      end = el ? Math.min(1, (el.scrollTop + el.clientHeight) / Math.max(1, el.scrollHeight)) : 0;
      where = `本章 ${Math.round(end * 100)}%`;
    } else { end = (page + 1) / pages; where = `${page + 1} / ${pages}`; }
    const percent = epub.percentAt(index, end);
    footLeft.textContent = chapterTitle();
    footRight.textContent = isScroll() ? `${Math.round(percent * 100)}%` : `${where}　${Math.round(percent * 100)}%`;
    slider.value = Math.round(percent * 1000);
    slider.style.setProperty('--v', `${percent * 100}%`);
    dockChapter.textContent = chapterTitle();
    dockPercent.textContent = `${Math.round(percent * 100)}%`;
    topSub.textContent = isScroll() ? where : `第 ${page + 1} / ${pages} 页`;
    if (save) setProgress(book.id, { index, fraction: fractionNow() }, percent);
  }

  // 翻页动画：滑动（平滑滚到目标页）/ 淡入 / 无
  let slideToken = 0;
  function slideTo(x) {
    const win = frame.contentWindow, from = win.scrollX, token = ++slideToken;
    const dist = x - from;
    if (!dist) return;
    const dur = Math.min(320, 160 + Math.abs(dist) / 6), t0 = performance.now();
    const step = (now) => {
      if (token !== slideToken || destroyed) return;
      const t = Math.min(1, (now - t0) / dur), ease = 1 - (1 - t) ** 3;
      win.scrollTo(from + dist * ease, 0);
      if (t < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }
  function show(p, save = true, animate = false) {
    page = Math.min(pages - 1, Math.max(0, p));
    const x = page * W, style = animate ? turnStyle() : 'none';
    if (style === 'slide') slideTo(x);
    else {
      slideToken++;
      frame.contentWindow?.scrollTo(x, 0);
      if (style === 'fade') frame.animate([{ opacity: 0.15 }, { opacity: 1 }], { duration: 200, easing: 'ease-out' });
    }
    refresh(save);
  }
  function goFraction(f, save = false) {
    if (isScroll()) { const el = scroller(); frame.contentWindow?.scrollTo(0, f * el.scrollHeight); refresh(save); }
    else show(Math.round(f * pages), save);
  }
  function chapterTitle() {
    const n = tocIndex();
    return n < 0 ? title : epub.toc[n].label;
  }
  function tocIndex(at = index) { // 某一章对应的目录项：同一章有多个锚点时取第一个
    const exact = epub.toc.findIndex((t) => t.index === at);
    if (exact >= 0) return exact;
    let n = -1;
    epub.toc.forEach((t, k) => { if (t.index < at) n = k; });
    return n;
  }

  async function settle(doc) {
    const imgs = [...doc.querySelectorAll('img')].map((img) => (img.complete ? null : new Promise((r) => {
      img.addEventListener('load', r, { once: true }); img.addEventListener('error', r, { once: true });
    })));
    const fonts = doc.fonts?.ready || Promise.resolve();
    await Promise.race([Promise.all([...imgs, fonts]), new Promise((r) => setTimeout(r, 2500))]);
  }

  /** 给刚载入的章节接上事件，并在首尾放上“上一章 / 下一章”（只在上下滚动时显示） */
  function wire(doc, i) {
    const make = (dir, text) => {
      const el = doc.createElementNS(doc.documentElement.namespaceURI || 'http://www.w3.org/1999/xhtml', 'div');
      el.setAttribute('class', 'shiori-nav'); el.setAttribute('data-shiori-nav', dir); el.textContent = text;
      return el;
    };
    const label = (at) => { const n = tocIndex(at); return n < 0 || epub.toc[n].index !== at ? '' : `：${epub.toc[n].label}`; };
    if (doc.body) {
      if (i > 0) doc.body.insertBefore(make('prev', `上一章${label(i - 1)}`), doc.body.firstChild);
      doc.body.appendChild(make('next', i < epub.spine.length - 1 ? `下一章${label(i + 1)}` : '全书完'));
    }
    doc.addEventListener('click', onDocClick);
    doc.addEventListener('keydown', onKey);
    frame.contentWindow.addEventListener('scroll', onDocScroll, { passive: true });
  }

  /** where: { fraction } | { hash } | { last: true }；dir 是换章方向，决定动画从哪边进来 */
  async function load(i, where = {}, save = true, dir = 0) {
    const token = ++loadToken;
    busy = true;
    frame.style.visibility = 'hidden';
    try {
      const url = await epub.chapter(i, buildCss());
      if (token !== loadToken || destroyed) return;
      await new Promise((resolve) => {
        frame.onload = resolve;
        // 用 replace 换章，避免 iframe 往浏览器历史里塞记录（否则“返回”会退回上一章而不是书架）
        if (frame.contentWindow && frame.src) frame.contentWindow.location.replace(url); else frame.src = url;
      });
      if (token !== loadToken || destroyed) return;
      const doc = frameDoc();
      wire(doc, i);
      await settle(doc);
      if (token !== loadToken || destroyed) return;
      index = i;
      measure();
      if (isScroll()) {
        const el = scroller();
        let y = 0;
        if (where.last) y = el.scrollHeight;
        else if (where.hash) y = anchorOffset(where.hash);
        else if (where.fraction) y = where.fraction * el.scrollHeight;
        frame.contentWindow.scrollTo(0, y);
        refresh(save);
      } else {
        let target = 0;
        if (where.last) target = pages - 1;
        else if (where.hash) target = Math.floor((anchorOffset(where.hash) + 1) / W);
        else if (where.fraction) target = Math.round(where.fraction * pages);
        show(target, save);
      }
      markToc();
    } catch (e) {
      console.error(e);
      toast(`这一章打不开：${e.message}`, { error: true });
    } finally {
      if (token === loadToken) {
        frame.style.visibility = ''; busy = false;
        const style = turnStyle();
        if (style !== 'none') {
          const shift = style === 'slide' && !isScroll() ? dir * 48 : 0;
          frame.animate([{ opacity: 0, transform: `translateX(${shift}px)` }, { opacity: 1, transform: 'none' }], { duration: 220, easing: 'ease-out' });
        }
      }
    }
  }
  /** 锚点在本章里的偏移：翻页时是横向，滚动时是纵向 */
  function anchorOffset(hash) {
    const doc = frameDoc();
    let el = doc.getElementById(hash);
    if (!el) { try { el = doc.querySelector(`[name="${CSS.escape(hash)}"]`); } catch { /* 忽略 */ } }
    if (!el) return 0;
    const r = el.getBoundingClientRect(), win = frame.contentWindow;
    return isScroll() ? Math.max(0, r.top + win.scrollY - 12) : r.left + win.scrollX;
  }
  function goAnchor(hash) {
    if (isScroll()) { frame.contentWindow.scrollTo(0, anchorOffset(hash)); refresh(); }
    else show(Math.floor((anchorOffset(hash) + 1) / W), true, true);
  }

  function relayout() {
    const doc = frameDoc();
    const style = doc?.getElementById('shiori-style');
    if (!style) return;
    const fraction = fractionNow();
    style.textContent = buildCss();
    measure();
    goFraction(fraction);
  }

  function next() {
    if (busy) return;
    if (isScroll()) {
      const el = scroller();
      if (el.scrollTop + el.clientHeight >= el.scrollHeight - 2) {
        if (index < epub.spine.length - 1) load(index + 1, {}, true, 1); else toast('已经是最后一页了');
      } else frame.contentWindow.scrollBy({ top: el.clientHeight * 0.88, behavior: calm ? 'auto' : 'smooth' });
      return;
    }
    if (page < pages - 1) show(page + 1, true, true);
    else if (index < epub.spine.length - 1) load(index + 1, {}, true, 1);
    else { show(page, false, true); toast('已经是最后一页了'); }
  }
  function prev() {
    if (busy) return;
    if (isScroll()) {
      const el = scroller();
      if (el.scrollTop <= 2) { if (index > 0) load(index - 1, { last: true }, true, -1); }
      else frame.contentWindow.scrollBy({ top: -el.clientHeight * 0.88, behavior: calm ? 'auto' : 'smooth' });
      return;
    }
    if (page > 0) show(page - 1, true, true);
    else if (index > 0) load(index - 1, { last: true }, true, -1);
    else show(page, false, true);
  }

  // ---------- 操作 ----------
  const chromeOpen = () => root.classList.contains('is-chrome');
  function toggleChrome(on = !chromeOpen()) { root.classList.toggle('is-chrome', on); }
  function openPanel(panel) {
    toggleChrome(false);
    if (panel === sheet) drawSheet();
    panel.hidden = false; scrim.hidden = false;
    if (panel === toc) tocList.querySelector('.is-current')?.scrollIntoView({ block: 'center' });
  }
  function closePanels() { toc.hidden = true; sheet.hidden = true; scrim.hidden = true; }
  const panelOpen = () => !scrim.hidden;

  /** 找出某个元素对应的插画地址（<img> 或 SVG 里的 <image>） */
  function imageOf(el) {
    const img = el?.closest?.('img');
    if (img) return img.currentSrc || img.getAttribute('src');
    const svg = el?.closest?.('svg');
    const inner = el?.localName === 'image' ? el : svg?.querySelector('image');
    return inner ? inner.getAttribute('href') || inner.getAttributeNS('http://www.w3.org/1999/xlink', 'href') : null;
  }
  function hitAt(x, y) {
    const rect = frame.getBoundingClientRect();
    return frameDoc()?.elementFromPoint(x - rect.left, y - rect.top);
  }
  function followLink(el) {
    const link = el?.closest?.('a[href]');
    const to = link && epub.resolveLink(index, link.getAttribute('href'));
    if (!to) return false;
    if (to.index === index) { if (to.hash) goAnchor(to.hash); } else load(to.index, { hash: to.hash }, true, Math.sign(to.index - index));
    return true;
  }

  // 翻页模式：盖在书页上的一层负责点按、拖动翻页、长按看插画
  let down = null, pressTimer = null;
  touch.addEventListener('pointerdown', (e) => {
    if (e.button > 0) return;
    down = { x: e.clientX, y: e.clientY, t: Date.now(), dragging: false };
    try { touch.setPointerCapture(e.pointerId); } catch { /* 忽略 */ }
    clearTimeout(pressTimer);
    pressTimer = setTimeout(() => { // 按住插画：放大查看
      const src = down && !down.dragging && imageOf(hitAt(down.x, down.y));
      if (src) { down = null; imageViewer(src); }
    }, 420);
  });
  touch.addEventListener('pointermove', (e) => {
    if (!down || busy) return;
    const dx = e.clientX - down.x, dy = e.clientY - down.y;
    if (!down.dragging && Math.abs(dx) > 10 && Math.abs(dx) > Math.abs(dy)) { down.dragging = true; clearTimeout(pressTimer); slideToken++; }
    else if (Math.abs(dy) > 10) clearTimeout(pressTimer);
    if (down.dragging && turnStyle() === 'slide') { // 书页跟着手指走
      const max = (pages - 1) * W;
      frame.contentWindow.scrollTo(Math.min(max, Math.max(0, page * W - dx)), 0);
    }
  });
  touch.addEventListener('pointerup', (e) => {
    clearTimeout(pressTimer);
    if (!down) return;
    const dx = e.clientX - down.x, dy = e.clientY - down.y, quick = Date.now() - down.t < 300;
    const dragged = down.dragging;
    down = null;
    if (dragged) {
      toggleChrome(false);
      if (Math.abs(dx) > Math.min(90, W * 0.2) || (quick && Math.abs(dx) > 30)) { if (dx < 0) next(); else prev(); }
      else show(page, false, true); // 没拖够，弹回去
      return;
    }
    if (Math.abs(dx) + Math.abs(dy) > 12) return;
    if (chromeOpen()) { toggleChrome(false); return; }
    if (followLink(hitAt(e.clientX, e.clientY))) return;
    const rect = frame.getBoundingClientRect();
    const x = (e.clientX - rect.left) / rect.width;
    if (x < 0.3) prev(); else if (x > 0.7) next(); else toggleChrome(true);
  });
  touch.addEventListener('pointercancel', () => { clearTimeout(pressTimer); if (down?.dragging) show(page, false, true); down = null; });
  touch.addEventListener('dblclick', (e) => { const src = imageOf(hitAt(e.clientX, e.clientY)); if (src) { toggleChrome(false); imageViewer(src); } });
  touch.addEventListener('contextmenu', (e) => e.preventDefault());
  // 双击后浏览器会选中文字，再拖动就变成“拖拽选区”而打断翻页，这里一并禁掉
  touch.addEventListener('dragstart', (e) => e.preventDefault());
  touch.addEventListener('mousedown', (e) => e.preventDefault());

  let lastWheel = 0;
  touch.addEventListener('wheel', (e) => {
    e.preventDefault();
    const now = Date.now();
    if (now - lastWheel < 220 || Math.abs(e.deltaY) + Math.abs(e.deltaX) < 4) return;
    lastWheel = now;
    if (e.deltaY + e.deltaX > 0) next(); else prev();
  }, { passive: false });

  // 上下滚动模式：书页自己滚，点按事件直接从书页里来
  function onDocClick(e) {
    if (!isScroll()) return;
    e.preventDefault();
    if (chromeOpen()) { toggleChrome(false); return; }
    const nav = e.target.closest?.('[data-shiori-nav]')?.getAttribute('data-shiori-nav');
    if (nav === 'prev') { load(index - 1, { last: true }, true, -1); return; }
    if (nav === 'next') { if (index < epub.spine.length - 1) load(index + 1, {}, true, 1); return; }
    if (followLink(e.target)) return;
    const src = imageOf(e.target);
    if (src) { imageViewer(src); return; }
    toggleChrome(true);
  }
  let scrollTick = false, saveTimer = null;
  function onDocScroll() {
    if (!isScroll() || busy || scrollTick) return;
    scrollTick = true;
    requestAnimationFrame(() => {
      scrollTick = false;
      if (destroyed || !isScroll()) return;
      refresh(false);
      clearTimeout(saveTimer);
      saveTimer = setTimeout(() => { if (!destroyed && isScroll()) refresh(true); }, 500);
    });
  }

  function onKey(e) {
    if (document.querySelector('dialog[open], .viewer') || /^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName) && e.target !== slider) return;
    if (e.key === 'Escape') { if (panelOpen()) closePanels(); else if (chromeOpen()) toggleChrome(false); else onExit(); return; }
    if (panelOpen() || e.target === slider) return;
    if (['ArrowRight', 'PageDown', ' ', 'ArrowDown'].includes(e.key)) { e.preventDefault(); next(); }
    else if (['ArrowLeft', 'PageUp', 'ArrowUp'].includes(e.key)) { e.preventDefault(); prev(); }
  }
  window.addEventListener('keydown', onKey);

  slider.addEventListener('input', () => { // 拖动时预览会跳到哪一章
    const n = tocIndex(epub.locate(slider.value / 1000).index);
    dockChapter.textContent = n < 0 ? title : epub.toc[n].label;
    dockPercent.textContent = `${Math.round(slider.value / 10)}%`;
    slider.style.setProperty('--v', `${slider.value / 10}%`);
  });
  slider.addEventListener('change', () => {
    const to = epub.locate(slider.value / 1000);
    load(to.index, { fraction: to.fraction });
  });

  let resizeTimer = null, firstResize = true;
  const observer = new ResizeObserver(() => {
    if (firstResize) { firstResize = false; return; }
    clearTimeout(resizeTimer); resizeTimer = setTimeout(relayout, 120);
  });
  observer.observe(frame.parentElement);

  // ---------- 目录 ----------
  function markToc() {
    const current = tocIndex();
    [...tocList.children].forEach((el, n) => el.classList.toggle('is-current', n === current));
  }
  if (epub.toc.length) {
    tocList.replaceChildren(...epub.toc.map((t) => h('button.toc-item', {
      type: 'button', style: `--depth:${Math.min(t.depth, 3)}`,
      onclick: () => { closePanels(); load(t.index, { hash: t.hash }, true, Math.sign(t.index - index)); },
    }, t.label)));
  } else tocList.append(h('p.panel-note', '这本书没有目录。'));

  // ---------- 排版设置 ----------
  function change(patch) {
    Object.assign(settings, patch);
    prefs.set('reader', settings);
    applyPaper(); relayout(); drawSheet();
  }
  function drawSheet() {
    const seg = (label, key, options) => h('div.sheet-row', h('span.sheet-label', label),
      h('div.segmented', { role: 'group', 'aria-label': label }, options.map(([value, text]) => h('button' + (settings[key] === value ? '.is-on' : ''), {
        type: 'button', onclick: () => change({ [key]: value }),
      }, text))));
    const rows = [
      seg('阅读方式', 'flow', [['paged', '左右翻页'], ['scroll', '上下滚动']]),
      h('div.sheet-row', h('span.sheet-label', '字号'),
        h('div.stepper',
          h('button', { type: 'button', 'aria-label': '减小字号', disabled: settings.fontSize <= 12, onclick: () => change({ fontSize: settings.fontSize - 1 }) }, 'A−'),
          h('span', settings.fontSize),
          h('button', { type: 'button', 'aria-label': '增大字号', disabled: settings.fontSize >= 34, onclick: () => change({ fontSize: settings.fontSize + 1 }) }, 'A+'))),
      seg('行距', 'lineHeight', [[1.5, '紧凑'], [1.8, '适中'], [2.1, '宽松']]),
      seg('页边距', 'margin', [[0, '窄'], [1, '中'], [2, '宽']]),
      seg('字体', 'font', Object.entries(FONTS).map(([k, f]) => [k, f.name])),
      h('div.sheet-row', h('span.sheet-label', '纸张'),
        h('div.swatches', Object.entries(PAPERS).map(([k, p]) => h('button.swatch' + (settings.paper === k ? '.is-on' : ''), {
          type: 'button', 'aria-label': `${p.name}色纸张`, style: `background:${p.bg};color:${p.fg}`, onclick: () => change({ paper: k }),
        }, p.name)))),
    ];
    if (!isScroll()) {
      rows.push(seg('翻页动画', 'turn', [['slide', '滑动'], ['fade', '淡入'], ['none', '无']]),
        seg('宽屏双页', 'spread', [[true, '开'], [false, '关']]));
    }
    sheet.replaceChildren(...rows);
  }

  // ---------- 打开到上次位置 ----------
  const loc = progress?.loc || {};
  const start = Number.isInteger(loc.index) && loc.index >= 0 && loc.index < epub.spine.length ? loc.index : 0;
  await load(start, { fraction: Number(loc.fraction) || 0 }, false);

  return {
    async destroy() {
      destroyed = true;
      observer.disconnect();
      window.removeEventListener('keydown', onKey);
      clearTimeout(resizeTimer); clearTimeout(saveTimer); clearTimeout(pressTimer);
      document.querySelector('.viewer')?.remove();
      root.remove();
      await epub.close();
    },
  };
}
