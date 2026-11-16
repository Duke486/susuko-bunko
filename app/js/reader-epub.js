// EPUB 阅读器。横排可左右翻页（CSS 多栏分页，宽屏双页，带动画）或上下滚动；竖排为从右往左翻页。
import { Epub } from './epub.js';
import { prefs, setProgress, saveMark, removeMark, marksOf, onChange } from './store.js';
import { h, icon, toast, dialog, menuButton, imageViewer, statusClock, fmtPercent } from './ui.js';

export const PAPERS = {
  white: { name: '奶白', bg: '#FBFAF5', fg: '#22252E', accent: '#C2255C', dark: false },
  paper: { name: '羊皮纸', bg: '#F3EAD6', fg: '#3A3226', accent: '#A8324F', dark: false },
  moss: { name: '浅苔', bg: '#E3EDE1', fg: '#26302A', accent: '#B02A5B', dark: false },
  night: { name: '夜读', bg: '#15171C', fg: '#B9BFCC', accent: '#F283A8', dark: true },
};
const FONTS = {
  book: { name: '原书', css: null },
  hei: { name: '黑体', css: '"PingFang SC","HarmonyOS Sans SC","Microsoft YaHei UI","Microsoft YaHei","Noto Sans CJK SC","Noto Sans SC",sans-serif' },
  ming: { name: '宋体', css: '"Source Han Serif SC","Noto Serif CJK SC","Noto Serif SC","Songti SC","Yu Mincho","SimSun",serif' },
};
const DEFAULTS = {
  fontSize: 18, lineHeight: 1.8, marginPx: 24, para: 0, font: 'book', paper: 'auto',
  spread: true, flow: 'paged', writing: 'h', turn: 'slide', volumeKeys: true,
};
export function readerSettings() {
  const saved = prefs.get('reader', {});
  const s = { ...DEFAULTS, ...saved };
  if (saved.marginPx == null && saved.margin != null) s.marginPx = [14, 24, 38][saved.margin] ?? 24; // 旧版的三档页边距
  if (s.paper !== 'auto' && !PAPERS[s.paper]) s.paper = 'white';
  return s;
}

export async function open({ host, book, title = book.title, source, progress, onExit }) {
  const epub = await Epub.open(source);
  const settings = readerSettings();
  let index = 0, page = 0, pages = 1, W = 0, H = 0, loadToken = 0, destroyed = false, busy = false;
  const isVertical = () => settings.writing === 'v';
  const isScroll = () => settings.flow === 'scroll' && !isVertical();
  const calm = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const turnStyle = () => (calm ? 'none' : settings.turn);
  const paper = () => {
    if (settings.paper === 'auto') return document.documentElement.dataset.theme === 'dark' ? PAPERS.night : PAPERS.white;
    return PAPERS[settings.paper] || PAPERS.white;
  };

  // ---------- 结构 ----------
  const frame = h('iframe.reader-frame', { sandbox: 'allow-same-origin', title, tabIndex: -1 });
  const touch = h('div.reader-touch');
  const pageMark = h('span.page-mark', { hidden: true, 'aria-hidden': 'true' });
  const clock = statusClock();
  const footCenter = h('span.foot-chapter');
  const footRight = h('span.foot-page');
  const slider = h('input.reader-slider', { type: 'range', min: 0, max: 1000, step: 1, 'aria-label': '全书进度' });
  const dockChapter = h('span.dock-chapter');
  const dockPercent = h('span.dock-percent');
  const topSub = h('span.reader-sub');
  const tocList = h('div.toc-list');
  const sheet = h('div.reader-sheet', { hidden: true });
  const toc = h('aside.reader-toc', { hidden: true }, h('h2', '目录'), tocList);
  const scrim = h('div.reader-scrim', { hidden: true, onclick: closePanels });
  const markBtn = h('button.icon-btn', { type: 'button', onclick: toggleBookmark });
  const nightBtn = menuButton('moon', '夜间', toggleNight);
  const root = h('div.reader',
    h('div.reader-stage', frame, touch, pageMark),
    h('footer.reader-foot', clock.el, footCenter, footRight),
    h('header.reader-top',
      h('button.icon-btn', { type: 'button', 'aria-label': '返回书架', onclick: onExit }, icon('back')),
      h('div.reader-heading', h('span.reader-title', title), topSub),
      markBtn,
      h('button.icon-btn', { type: 'button', 'aria-label': '阅读设置', title: '阅读设置', onclick: () => openSheet('type') }, icon('type'))),
    h('div.reader-bottom',
      h('div.dock-info', dockChapter, dockPercent),
      h('div.bottom-row',
        h('button.icon-btn', { type: 'button', 'aria-label': '上一章', title: '上一章', onclick: () => { if (index > 0) load(index - 1, {}, true, -1); } }, icon('prev')),
        slider,
        h('button.icon-btn', { type: 'button', 'aria-label': '下一章', title: '下一章', onclick: () => { if (index < epub.spine.length - 1) load(index + 1, {}, true, 1); } }, icon('next'))),
      h('div.bottom-actions',
        menuButton('list', '目录', () => openPanel(toc)),
        menuButton('bookmark', '书签', () => openSheet('marks')),
        nightBtn,
        menuButton('type', '设置', () => openSheet('type')))),
    scrim, toc, sheet);
  host.replaceChildren(root);
  applyPaper();

  function applyPaper() {
    const p = paper();
    root.style.setProperty('--paper', p.bg);
    root.style.setProperty('--paper-ink', p.fg);
    root.style.setProperty('--paper-accent', p.accent);
    root.dataset.dark = String(p.dark);
    root.classList.toggle('is-scroll', isScroll());
    nightBtn.replaceChildren(icon(p.dark ? 'sun' : 'moon', 22), h('span', p.dark ? '日间' : '夜间'));
  }
  function toggleNight() {
    if (paper().dark) change({ paper: settings.dayPaper && settings.dayPaper !== 'night' ? settings.dayPaper : 'white' });
    else change({ dayPaper: settings.paper === 'auto' ? 'white' : settings.paper, paper: 'night' });
  }

  // ---------- 排版 ----------
  function buildCss() {
    const stage = frame.parentElement;
    W = Math.max(200, Math.floor(stage.clientWidth));
    H = Math.max(200, Math.floor(stage.clientHeight));
    const wide = W >= 700;
    const cols = !isScroll() && !isVertical() && settings.spread && W >= 1000 && W > H * 1.15 ? 2 : 1;
    let padH = Math.round(settings.marginPx * (wide ? 2 : 1));
    if (cols === 1 && !isVertical()) padH = Math.max(padH, Math.round((W - 780) / 2));
    const gap = padH * 2;
    const colW = (W - padH * 2 - (cols - 1) * gap) / cols;
    const padV = wide ? 36 : 22;
    const p = paper();
    const font = FONTS[settings.font] || FONTS.book;
    const root0 = `margin:0!important;padding:0!important;background:${p.bg}!important;font-size:${settings.fontSize}px!important;-webkit-text-size-adjust:100%!important`;
    const text = `background:transparent!important;color:${p.fg}!important;font-size:1rem!important;line-height:${settings.lineHeight}!important;font-family:${FONTS.hei.css};
text-align:justify;overflow-wrap:break-word;line-break:strict;-webkit-user-select:none;user-select:none`;
    let layout;
    if (isVertical()) { // 竖排：一页就是一“栏”，栏沿着文字方向（向下）排，所以翻页是纵向滚一屏
      layout = `
html{${root0};width:${W}px!important;height:${H}px!important;overflow:hidden!important;writing-mode:vertical-rl!important}
body{margin:0!important;padding:${padV}px ${padH}px!important;box-sizing:border-box!important;width:${W}px!important;height:${H}px!important;max-width:none!important;min-width:0!important;writing-mode:vertical-rl!important;
column-width:${H - padV * 2}px!important;column-gap:${padV * 2}px!important;column-fill:auto!important;column-rule:none!important;overflow:visible!important;
${text};text-orientation:mixed}
img,svg,video{max-width:${W - padH * 2}px!important;max-height:${H - padV * 2}px!important;object-fit:contain;break-inside:avoid!important}
.shiori-nav{display:none!important}`;
    } else if (isScroll()) {
      layout = `
html{${root0};width:auto!important;height:auto!important;overflow-x:hidden!important;overflow-y:auto!important;scrollbar-width:thin}
body{margin:0!important;padding:${padV}px ${padH}px 48px!important;box-sizing:border-box!important;width:auto!important;height:auto!important;max-width:none!important;min-width:0!important;columns:auto!important;overflow:visible!important;
${text}}
img,svg,video{max-width:100%!important;max-height:${H}px!important;height:auto;object-fit:contain}
.shiori-nav{display:block;margin:2.2em 0 .6em;padding:15px;border-radius:14px;text-align:center;text-indent:0;font-size:14px;line-height:1.4;cursor:pointer;background:color-mix(in srgb,${p.fg} 8%,transparent)}
.shiori-nav[data-shiori-nav="prev"]{margin:0 0 1.6em}`;
    } else {
      layout = `
html{${root0};width:${W}px!important;height:${H}px!important;overflow:hidden!important}
body{margin:0!important;padding:${padV}px ${padH}px!important;box-sizing:border-box!important;width:${W}px!important;height:${H}px!important;max-width:none!important;min-width:0!important;
column-width:${colW}px!important;column-gap:${gap}px!important;column-fill:auto!important;column-rule:none!important;overflow:visible!important;
${text}}
img,svg,video{max-width:100%!important;max-height:${H - padV * 2}px!important;object-fit:contain;break-inside:avoid!important}
.shiori-nav{display:none!important}`;
    }
    const custom = settings.paper === 'auto' ? p !== PAPERS.white : settings.paper !== 'white';
    return `${layout}
${isVertical() ? '' : '*{writing-mode:horizontal-tb!important;text-combine-upright:none!important}'}
p,li,dd,blockquote{line-height:inherit!important;orphans:1;widows:1}
${settings.para > 0 ? `p{margin-block:0 ${settings.para}px!important}` : ''}
a{color:${p.accent}!important;text-decoration:none!important}
${custom ? `body *{color:inherit!important;background-color:transparent!important;border-color:currentColor!important}body a{color:${p.accent}!important}` : ''}
${font.css ? `body,body *{font-family:${font.css}!important}` : ''}`;
  }

  const frameDoc = () => frame.contentDocument;
  const scroller = () => frameDoc()?.documentElement;
  function measure() {
    const el = scroller();
    if (!el || isScroll()) return;
    pages = isVertical() ? Math.max(1, Math.ceil((el.scrollHeight - 2) / H)) : Math.max(1, Math.ceil((el.scrollWidth - 2) / W));
  }
  /** 本章内的位置 0~1（页或滚动位置的起点） */
  function fractionNow() {
    if (!isScroll()) return page / pages;
    const el = scroller();
    return el && el.scrollHeight > 0 ? el.scrollTop / el.scrollHeight : 0;
  }
  /** 当前画面覆盖本章的哪一段 [起, 止) */
  function spanNow() {
    if (!isScroll()) return [page / pages, (page + 1) / pages];
    const el = scroller();
    if (!el || !el.scrollHeight) return [0, 1];
    return [el.scrollTop / el.scrollHeight, Math.min(1, (el.scrollTop + el.clientHeight) / el.scrollHeight)];
  }
  let lastPercent = 0;
  function refresh(save = true) { // 更新页脚、进度条、书签标记，并记录进度
    const end = spanNow()[1];
    const percent = lastPercent = epub.percentAt(index, end);
    const pct = `${Math.round(percent * 100)}%`;
    const where = isScroll() ? `本章 ${Math.round(end * 100)}%` : `${page + 1} / ${pages}`;
    footCenter.textContent = chapterTitle();
    footRight.textContent = isScroll() ? pct : `${where}　${pct}`;
    slider.value = Math.round(percent * 1000);
    slider.style.setProperty('--v', `${percent * 100}%`);
    dockChapter.textContent = chapterTitle();
    dockPercent.textContent = pct;
    topSub.textContent = isScroll() ? where : `第 ${page + 1} / ${pages} 页`;
    drawBookmarkState();
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
    const before = page;
    page = Math.min(pages - 1, Math.max(0, p));
    const style = animate ? turnStyle() : 'none';
    if (isVertical()) {
      frame.contentWindow?.scrollTo(0, page * H);
      if (style !== 'none' && page !== before) { // 竖排从右往左翻：下一页从左边进来
        const from = style === 'slide' ? (page > before ? -7 : 7) : 0;
        frame.animate([{ opacity: 0.1, transform: `translateX(${from}%)` }, { opacity: 1, transform: 'none' }], { duration: 230, easing: 'ease-out' });
      }
    } else if (style === 'slide') slideTo(page * W);
    else {
      slideToken++;
      frame.contentWindow?.scrollTo(page * W, 0);
      if (style === 'fade') frame.animate([{ opacity: 0.15 }, { opacity: 1 }], { duration: 200, easing: 'ease-out' });
    }
    refresh(save);
  }
  function goFraction(f, save = false) {
    if (isScroll()) { const el = scroller(); frame.contentWindow?.scrollTo(0, f * el.scrollHeight); refresh(save); }
    else show(Math.min(pages - 1, Math.floor(f * pages + 0.0001)), save);
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
        else if (where.hash) target = anchorPage(where.hash);
        else if (where.fraction) target = Math.min(pages - 1, Math.floor(where.fraction * pages + 0.0001));
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
          const shift = style === 'slide' && !isScroll() ? dir * 48 * (isVertical() ? -1 : 1) : 0;
          frame.animate([{ opacity: 0, transform: `translateX(${shift}px)` }, { opacity: 1, transform: 'none' }], { duration: 220, easing: 'ease-out' });
        }
      }
    }
  }
  /** 锚点在本章里的偏移（沿翻页 / 滚动方向） */
  function anchorOffset(hash) {
    const doc = frameDoc();
    let el = doc.getElementById(hash);
    if (!el) { try { el = doc.querySelector(`[name="${CSS.escape(hash)}"]`); } catch { /* 忽略 */ } }
    if (!el) return 0;
    const r = el.getBoundingClientRect(), win = frame.contentWindow;
    if (isScroll()) return Math.max(0, r.top + win.scrollY - 12);
    return isVertical() ? r.top + win.scrollY : r.left + win.scrollX;
  }
  const anchorPage = (hash) => Math.floor((anchorOffset(hash) + 1) / (isVertical() ? H : W));
  function goAnchor(hash) {
    if (isScroll()) { frame.contentWindow.scrollTo(0, anchorOffset(hash)); refresh(); }
    else show(anchorPage(hash), true, true);
  }

  function relayout() {
    const doc = frameDoc();
    const style = doc?.getElementById('shiori-style');
    if (!style) return;
    const fraction = fractionNow();
    style.textContent = buildCss();
    frame.contentWindow.scrollTo(0, 0);
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
  // 屏幕左 / 右对应的翻页方向：竖排是从右往左读，所以左边是“下一页”
  const leftward = () => (isVertical() ? next() : prev());
  const rightward = () => (isVertical() ? prev() : next());

  // ---------- 面板 ----------
  const chromeOpen = () => root.classList.contains('is-chrome');
  function toggleChrome(on = !chromeOpen()) { root.classList.toggle('is-chrome', on); }
  function openPanel(panel) {
    toggleChrome(false);
    toc.hidden = true; sheet.hidden = true;
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
    if (down.dragging && turnStyle() === 'slide' && !isVertical()) { // 书页跟着手指走
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
      // 手指往左拖 = 把右边的内容拉进来；竖排时右边是上一页
      if (Math.abs(dx) > Math.min(90, W * 0.2) || (quick && Math.abs(dx) > 30)) { if (dx < 0) rightward(); else leftward(); }
      else show(page, false, true); // 没拖够，弹回去
      return;
    }
    if (Math.abs(dx) + Math.abs(dy) > 12) return;
    if (chromeOpen()) { toggleChrome(false); return; }
    if (followLink(hitAt(e.clientX, e.clientY))) return;
    const rect = frame.getBoundingClientRect();
    const x = (e.clientX - rect.left) / rect.width;
    if (x < 0.3) leftward(); else if (x > 0.7) rightward(); else toggleChrome(true);
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
    if (document.querySelector('dialog[open], .viewer') || /^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName)) return;
    if (e.key === 'Escape') { if (panelOpen()) closePanels(); else if (chromeOpen()) toggleChrome(false); else onExit(); return; }
    if (panelOpen()) return;
    if (e.key === 'ArrowLeft') { e.preventDefault(); leftward(); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); rightward(); }
    else if (['PageDown', ' ', 'ArrowDown'].includes(e.key)) { e.preventDefault(); next(); }
    else if (['PageUp', 'ArrowUp'].includes(e.key)) { e.preventDefault(); prev(); }
  }
  window.addEventListener('keydown', onKey);

  // 安卓音量键翻页：原生层把按键转成 volumekey 事件
  function onVolume(e) {
    if (panelOpen() || document.querySelector('dialog[open], .viewer')) return;
    if (e.detail === 'down') next(); else prev();
  }
  const native = window.SusukoNative;
  const syncVolumeKeys = (on) => { try { native?.setVolumeKeys(!!on); } catch { /* 网页版没有原生层 */ } };
  window.addEventListener('volumekey', onVolume);
  syncVolumeKeys(settings.volumeKeys);

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

  // ---------- 书签与笔记 ----------
  /** 当前画面开头的一小段文字，用来在列表里认出这个位置 */
  function excerptNow() {
    try {
      const doc = frameDoc();
      const style = doc.defaultView.getComputedStyle(doc.body);
      const x = isVertical() ? W - parseFloat(style.paddingRight) - 6 : parseFloat(style.paddingLeft) + 6;
      const range = doc.caretRangeFromPoint(x, parseFloat(style.paddingTop) + 6);
      if (!range) return '';
      const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
      walker.currentNode = range.startContainer;
      let text = range.startContainer.nodeType === 3 ? range.startContainer.textContent.slice(range.startOffset) : '';
      while (text.replace(/\s+/g, '').length < 48 && walker.nextNode()) {
        if (!walker.currentNode.parentElement?.closest('rt, rp, .shiori-nav, style, script')) text += walker.currentNode.textContent;
      }
      return text.replace(/\s+/g, ' ').trim().slice(0, 60);
    } catch { return ''; }
  }
  const bookmarkHere = () => {
    const [from, to] = spanNow();
    return marksOf(book.id).find((m) => m.type === 'bookmark' && m.loc?.index === index && m.loc.fraction >= from - 1e-6 && m.loc.fraction < to - 1e-6);
  };
  function drawBookmarkState() {
    const on = !!bookmarkHere();
    pageMark.hidden = !on;
    markBtn.replaceChildren(icon(on ? 'bookmarkOn' : 'bookmark'));
    markBtn.classList.toggle('is-on', on);
    const label = on ? '取消这一页的书签' : '给这一页加书签';
    markBtn.title = label; markBtn.setAttribute('aria-label', label);
  }
  const markHere = (extra) => ({ loc: { index, fraction: fractionNow() }, percent: lastPercent, chapter: chapterTitle(), excerpt: excerptNow(), ...extra });
  function toggleBookmark() {
    const existing = bookmarkHere();
    if (existing) { removeMark(book.id, existing.id); toast('已取消书签'); }
    else { saveMark(book.id, markHere({ type: 'bookmark' })); toast('已加书签'); }
    drawBookmarkState();
    if (!sheet.hidden) drawSheet();
  }
  function editNote(existing) {
    const base = existing || markHere({ type: 'note' });
    return dialog(existing ? '修改笔记' : '写笔记', (close) => {
      const area = h('textarea.field.is-area', { value: base.text || '', rows: 5, maxLength: 5000, placeholder: '在这里写下想法…' });
      setTimeout(() => area.focus(), 40);
      return h('form.dialog-body', {
        onsubmit: (e) => {
          e.preventDefault();
          if (!area.value.trim()) { area.focus(); return; }
          saveMark(book.id, { ...base, text: area.value.trim() });
          close(); toast(existing ? '笔记已修改' : '笔记已保存');
          if (!sheet.hidden) drawSheet();
        },
      },
      h('p.note-where', `${base.chapter}　${fmtPercent(Math.max(base.percent, 0.01))}`),
      base.excerpt && h('blockquote.note-quote', base.excerpt + '…'),
      area,
      h('div.dialog-actions',
        h('button.btn', { type: 'button', onclick: () => close() }, '取消'),
        h('button.btn.is-primary', { type: 'submit' }, '保存')));
    });
  }
  function jumpToMark(m) {
    closePanels();
    const i = Number.isInteger(m.loc?.index) && m.loc.index < epub.spine.length ? m.loc.index : 0;
    load(i, { fraction: Number(m.loc?.fraction) || 0 }, true, Math.sign(i - index));
  }
  function markList(type) {
    const list = marksOf(book.id).filter((m) => m.type === type);
    if (!list.length) {
      return h('p.panel-note', type === 'bookmark' ? '还没有书签。翻到想记住的地方，点上面的按钮。' : '还没有笔记。翻到想记录的地方，点上面的按钮写下想法。');
    }
    return h('div.mark-list', list.map((m) => h('div.mark-item',
      h('button.mark-main', { type: 'button', onclick: () => jumpToMark(m) },
        h('span.mark-title', m.chapter || title),
        m.type === 'note' && h('span.mark-text', m.text),
        m.excerpt && h('span.mark-excerpt', m.excerpt + '…'),
        h('span.mark-meta', `${fmtPercent(Math.max(m.percent, 0.01))}　${new Date(m.createdAt).toLocaleDateString()}`)),
      type === 'note' && h('button.icon-btn', { type: 'button', 'aria-label': '修改笔记', onclick: () => editNote(m) }, icon('pen', 18)),
      h('button.icon-btn', { type: 'button', 'aria-label': type === 'note' ? '删除笔记' : '删除书签', onclick: () => { removeMark(book.id, m.id); drawSheet(); drawBookmarkState(); } }, icon('trash', 18)))));
  }

  // ---------- 设置面板（排版 / 操作 / 书签 / 笔记） ----------
  let tab = 'type', relayoutQueued = false;
  function openSheet(which) { tab = which; drawSheet(); openPanel(sheet); }
  function change(patch, redraw = true) {
    Object.assign(settings, patch);
    prefs.set('reader', settings);
    applyPaper();
    if (!relayoutQueued) { relayoutQueued = true; requestAnimationFrame(() => { relayoutQueued = false; if (!destroyed) relayout(); }); }
    if (redraw) drawSheet();
  }
  function drawSheet() {
    const seg = (label, key, options, hint) => h('div.sheet-row', h('span.sheet-label', label, hint && h('small', hint)),
      h('div.segmented', { role: 'group', 'aria-label': label }, options.map(([value, text]) => h('button' + (settings[key] === value ? '.is-on' : ''), {
        type: 'button', onclick: () => change({ [key]: value }),
      }, text))));
    const range = (label, key, min, max, step, fmt) => {
      const value = h('span.range-value', fmt(settings[key]));
      const input = h('input.reader-slider', { type: 'range', min, max, step, value: settings[key], 'aria-label': label });
      const fill = () => input.style.setProperty('--v', `${((input.value - min) / (max - min)) * 100}%`);
      fill();
      input.addEventListener('input', () => { const v = Number(input.value); value.textContent = fmt(v); fill(); change({ [key]: v }, false); });
      return h('div.range-row', h('div.range-head', h('span.sheet-label', label), value), input);
    };
    let body;
    if (tab === 'type') {
      body = [
        h('div.sheet-block', h('span.sheet-label', '阅读配色'),
          h('div.chips', [['auto', { name: '跟随外观', bg: 'linear-gradient(135deg,#FBFAF5 50%,#15171C 50%)' }], ...Object.entries(PAPERS)].map(([k, p]) => h('button.chip' + (settings.paper === k ? '.is-on' : ''), {
            type: 'button', 'aria-pressed': String(settings.paper === k), onclick: () => change({ paper: k }),
          }, h('span.chip-dot', { style: `background:${p.bg}` }), p.name)))),
        range('字体大小', 'fontSize', 12, 34, 1, (v) => `${v} px`),
        range('行距', 'lineHeight', 1.2, 2.6, 0.05, (v) => `${v.toFixed(2)} 倍`),
        range('页边距', 'marginPx', 6, 60, 1, (v) => `${v} px`),
        range('段落间距', 'para', 0, 32, 1, (v) => (v ? `${v} px` : '跟随原书')),
        seg('字体', 'font', Object.entries(FONTS).map(([k, f]) => [k, f.name])),
      ];
    } else if (tab === 'act') {
      body = [
        seg('文字方向', 'writing', [['h', '横排'], ['v', '竖排']]),
        !isVertical() && seg('阅读方式', 'flow', [['paged', '左右翻页'], ['scroll', '上下滚动']]),
        !isScroll() && seg('翻页动画', 'turn', [['slide', '滑动'], ['fade', '淡入'], ['none', '无']]),
        !isScroll() && !isVertical() && seg('宽屏双页', 'spread', [[true, '开'], [false, '关']]),
        native && h('div.sheet-row', h('span.sheet-label', '音量键翻页'),
          h('div.segmented', { role: 'group', 'aria-label': '音量键翻页' }, [[true, '开'], [false, '关']].map(([v, text]) => h('button' + (settings.volumeKeys === v ? '.is-on' : ''), {
            type: 'button', onclick: () => { change({ volumeKeys: v }); syncVolumeKeys(v); },
          }, text)))),
        h('p.panel-note', isVertical() ? '竖排时从右往左读：点屏幕左侧是下一页，右侧是上一页。按住插画可以放大。'
          : '点屏幕两侧翻页，点中间呼出菜单。按住插画可以放大。'),
      ];
    } else if (tab === 'marks') {
      const on = !!bookmarkHere();
      body = [
        h('button.btn.is-block.is-soft', { type: 'button', onclick: toggleBookmark }, icon(on ? 'bookmarkOn' : 'bookmark', 18), on ? '取消这一页的书签' : '给这一页加书签'),
        markList('bookmark'),
      ];
    } else {
      body = [
        h('button.btn.is-block.is-soft', { type: 'button', onclick: () => editNote() }, icon('pen', 18), '在这一页写笔记'),
        markList('note'),
      ];
    }
    const tabs = [['type', '排版'], ['act', '操作'], ['marks', '书签'], ['notes', '笔记']];
    sheet.replaceChildren(
      h('div.sheet-head', h('h2', '阅读设置'),
        h('button.icon-btn', { type: 'button', 'aria-label': '关闭', onclick: closePanels }, icon('close'))),
      h('div.sheet-tabs', { role: 'tablist' }, tabs.map(([k, text]) => h('button' + (tab === k ? '.is-on' : ''), {
        type: 'button', role: 'tab', 'aria-selected': String(tab === k), onclick: () => { tab = k; drawSheet(); },
      }, text))),
      h('div.sheet-body', body.filter(Boolean)));
  }
  // 别的设备同步来了新书签，或应用主题变了（“跟随外观”）
  const unsubscribe = onChange(() => { if (!destroyed) { drawBookmarkState(); } });
  const themeWatch = new MutationObserver(() => { if (settings.paper === 'auto') { applyPaper(); relayout(); } });
  themeWatch.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

  // ---------- 打开到上次位置 ----------
  const loc = progress?.loc || {};
  const start = Number.isInteger(loc.index) && loc.index >= 0 && loc.index < epub.spine.length ? loc.index : 0;
  await load(start, { fraction: Number(loc.fraction) || 0 }, false);

  return {
    async destroy() {
      destroyed = true;
      observer.disconnect(); themeWatch.disconnect(); unsubscribe(); clock.stop();
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('volumekey', onVolume);
      syncVolumeKeys(false);
      clearTimeout(resizeTimer); clearTimeout(saveTimer); clearTimeout(pressTimer);
      document.querySelector('.viewer')?.remove();
      root.remove();
      await epub.close();
    },
  };
}
