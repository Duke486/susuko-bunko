// EPUB 阅读器：横排、左右翻页（CSS 多栏分页），宽屏可双页。
import { Epub } from './epub.js';
import { prefs, setProgress } from './store.js';
import { h, icon, toast, menuButton } from './ui.js';

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
const DEFAULTS = { fontSize: 18, lineHeight: 1.8, margin: 1, font: 'book', paper: 'white', spread: true };
export const readerSettings = () => ({ ...DEFAULTS, ...prefs.get('reader', {}) });

export async function open({ host, book, title = book.title, source, progress, onExit }) {
  const epub = await Epub.open(source);
  const settings = readerSettings();
  let index = 0, page = 0, pages = 1, W = 0, loadToken = 0, destroyed = false, busy = false;

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
  h('div.bottom-actions',
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
        h('button.icon-btn', { type: 'button', 'aria-label': '上一章', title: '上一章', onclick: () => { if (index > 0) load(index - 1); } }, icon('prev')),
        slider,
        h('button.icon-btn', { type: 'button', 'aria-label': '下一章', title: '下一章', onclick: () => { if (index < epub.spine.length - 1) load(index + 1); } }, icon('next'))),
      nightBtn.parentElement),
    scrim, toc, sheet);
  host.replaceChildren(root);
  applyPaper();

  function applyPaper() {
    const p = PAPERS[settings.paper] || PAPERS.white;
    root.style.setProperty('--paper', p.bg);
    root.style.setProperty('--paper-ink', p.fg);
    root.style.setProperty('--paper-accent', p.accent);
    root.dataset.dark = String(p.dark);
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
    const H = Math.max(200, Math.floor(stage.clientHeight));
    const wide = W >= 700;
    const cols = settings.spread && W >= 1000 && W > H * 1.15 ? 2 : 1;
    let padH = (wide ? [32, 56, 88] : [14, 24, 38])[settings.margin];
    if (cols === 1) padH = Math.max(padH, Math.round((W - 780) / 2));
    const gap = padH * 2;
    const colW = (W - padH * 2 - (cols - 1) * gap) / cols;
    const padV = wide ? 36 : 22;
    const p = PAPERS[settings.paper] || PAPERS.white;
    const font = FONTS[settings.font] || FONTS.book;
    return `
html{margin:0!important;padding:0!important;width:${W}px!important;height:${H}px!important;overflow:hidden!important;background:${p.bg}!important;font-size:${settings.fontSize}px!important;-webkit-text-size-adjust:100%!important}
body{margin:0!important;padding:${padV}px ${padH}px!important;box-sizing:border-box!important;width:${W}px!important;height:${H}px!important;max-width:none!important;min-width:0!important;
column-width:${colW}px!important;column-gap:${gap}px!important;column-fill:auto!important;column-rule:none!important;overflow:visible!important;
background:transparent!important;color:${p.fg}!important;font-size:1rem!important;line-height:${settings.lineHeight}!important;font-family:${FONTS.hei.css};
text-align:justify;overflow-wrap:break-word;line-break:strict;-webkit-user-select:none;user-select:none}
*{writing-mode:horizontal-tb!important;text-combine-upright:none!important}
p,li,dd,blockquote{line-height:inherit!important;orphans:1;widows:1}
img,svg,video{max-width:100%!important;max-height:${H - padV * 2}px!important;object-fit:contain;break-inside:avoid!important}
a{color:${p.accent}!important;text-decoration:none!important}
${settings.paper === 'white' ? '' : `body *{color:inherit!important;background-color:transparent!important;border-color:currentColor!important}body a{color:${p.accent}!important}`}
${font.css ? `body,body *{font-family:${font.css}!important}` : ''}`;
  }

  const frameDoc = () => frame.contentDocument;
  function measure() {
    const doc = frameDoc();
    if (!doc?.documentElement) return;
    pages = Math.max(1, Math.ceil((doc.documentElement.scrollWidth - 2) / W));
  }
  function show(p, save = true) {
    page = Math.min(pages - 1, Math.max(0, p));
    frame.contentWindow?.scrollTo(page * W, 0);
    const percent = epub.percentAt(index, (page + 1) / pages);
    footLeft.textContent = chapterTitle();
    footRight.textContent = `${page + 1} / ${pages}　${Math.round(percent * 100)}%`;
    slider.value = Math.round(percent * 1000);
    slider.style.setProperty('--v', `${percent * 100}%`);
    dockChapter.textContent = chapterTitle();
    dockPercent.textContent = `${Math.round(percent * 100)}%`;
    topSub.textContent = `第 ${page + 1} / ${pages} 页`;
    if (save) setProgress(book.id, { index, fraction: page / pages }, percent);
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

  /** where: { fraction } | { hash } | { last: true } */
  async function load(i, where = {}, save = true) {
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
      await settle(frameDoc());
      if (token !== loadToken || destroyed) return;
      index = i;
      measure();
      let target = 0;
      if (where.last) target = pages - 1;
      else if (where.hash) target = pageOfAnchor(where.hash);
      else if (where.fraction) target = Math.round(where.fraction * pages);
      show(target, save);
      markToc();
    } catch (e) {
      console.error(e);
      toast(`这一章打不开：${e.message}`, { error: true });
    } finally {
      if (token === loadToken) { frame.style.visibility = ''; busy = false; }
    }
  }
  function pageOfAnchor(hash) {
    const doc = frameDoc();
    let el = doc.getElementById(hash);
    if (!el) { try { el = doc.querySelector(`[name="${CSS.escape(hash)}"]`); } catch { /* 忽略 */ } }
    if (!el) return 0;
    return Math.floor((el.getBoundingClientRect().left + frame.contentWindow.scrollX + 1) / W);
  }

  function relayout() {
    const doc = frameDoc();
    const style = doc?.getElementById('shiori-style');
    if (!style) return;
    const fraction = page / pages;
    style.textContent = buildCss();
    measure();
    show(Math.round(fraction * pages), false);
  }

  function next() {
    if (busy) return;
    if (page < pages - 1) show(page + 1);
    else if (index < epub.spine.length - 1) load(index + 1);
    else toast('已经是最后一页了');
  }
  function prev() {
    if (busy) return;
    if (page > 0) show(page - 1);
    else if (index > 0) load(index - 1, { last: true });
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

  let down = null;
  touch.addEventListener('pointerdown', (e) => { down = { x: e.clientX, y: e.clientY, t: Date.now() }; });
  touch.addEventListener('pointerup', (e) => {
    if (!down) return;
    const dx = e.clientX - down.x, dy = e.clientY - down.y;
    down = null;
    if (Math.abs(dx) > 40 && Math.abs(dx) > Math.abs(dy) * 1.5) { // 滑动翻页
      toggleChrome(false);
      if (dx < 0) next(); else prev();
      return;
    }
    if (Math.abs(dx) + Math.abs(dy) > 12) return;
    if (chromeOpen()) { toggleChrome(false); return; }
    const rect = frame.getBoundingClientRect();
    const hit = frameDoc()?.elementFromPoint(e.clientX - rect.left, e.clientY - rect.top);
    const link = hit?.closest?.('a[href]');
    if (link) {
      const to = epub.resolveLink(index, link.getAttribute('href'));
      if (to) { if (to.index === index && to.hash) show(pageOfAnchor(to.hash)); else load(to.index, { hash: to.hash }); return; }
    }
    const x = (e.clientX - rect.left) / rect.width;
    if (x < 0.3) prev(); else if (x > 0.7) next(); else toggleChrome(true);
  });
  touch.addEventListener('pointercancel', () => { down = null; });

  let lastWheel = 0;
  touch.addEventListener('wheel', (e) => {
    e.preventDefault();
    const now = Date.now();
    if (now - lastWheel < 220 || Math.abs(e.deltaY) + Math.abs(e.deltaX) < 4) return;
    lastWheel = now;
    if (e.deltaY + e.deltaX > 0) next(); else prev();
  }, { passive: false });

  function onKey(e) {
    if (document.querySelector('dialog[open]') || /^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName) && e.target !== slider) return;
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
      onclick: () => { closePanels(); load(t.index, { hash: t.hash }); },
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
    sheet.replaceChildren(
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
      seg('宽屏双页', 'spread', [[true, '开'], [false, '关']]),
    );
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
      clearTimeout(resizeTimer);
      root.remove();
      await epub.close();
    },
  };
}
