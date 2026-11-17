// 书脊：照着日本文库本书脊的结构排——顶上文库小标，人物小图，竖排书名，卷号，作者，最下面文库名。
// 文字大小都用书脊自己的宽高（容器单位 cqw / cqh）来算，所以 3D 书架上大小怎么变，比例都一样。
import { h } from './ui.js';
import { logoUrl } from './labels.js';

export const SPINE_RATIO = 7.1; // 书脊高 ÷ 宽（书 1 : 1.42，厚度是宽的 0.2）

/** "0.5,0.25" → {x, y}；'none' = 不要人物图；空 = 默认位置 */
export function parseFace(v) {
  if (v === 'none') return null;
  const [x, y] = String(v || '').split(',').map(Number);
  return Number.isFinite(x) && Number.isFinite(y) ? { x: clamp01(x), y: clamp01(y) } : { x: 0.5, y: 0.24 };
}
const clamp01 = (n) => Math.min(1, Math.max(0, n));

// 书名按长短选字号，太长就分成两三行竖排
function titleSize(len, slot) {
  const room = slot * SPINE_RATIO * 100; // 这一段有多高（单位 cqw）
  for (const [lines, max, min] of [[1, 60, 34], [2, 38, 24], [3, 27, 0]]) {
    const fs = Math.min(max, (room * lines) / Math.max(1, len * 1.08));
    if (fs >= min) return { fs, lines };
  }
  return { fs: 22, lines: 3 };
}
const vlen = (s) => [...String(s || '')].reduce((n, ch) => n + (/[\x20-\x7e]/.test(ch) ? 0.55 : 1), 0);

const PORTRAIT_H = 72; // 人物图高度（cqw），宽是 88cqw
const ZOOM = 3; // 封面放大几倍：书脊上只露出封面宽度的三分之一
function placePortrait(el, url, face) {
  el.style.backgroundImage = `url("${url}")`;
  el.style.backgroundSize = `${ZOOM * 100}% auto`;
  const boxW = 88, imgW = boxW * ZOOM, imgH = imgW * 1.42;
  const px = (face.x * imgW - boxW / 2) / (imgW - boxW);
  const py = (face.y * imgH - PORTRAIT_H / 2) / (imgH - PORTRAIT_H);
  el.style.backgroundPosition = `${(clamp01(px) * 100).toFixed(1)}% ${(clamp01(py) * 100).toFixed(1)}%`;
}

/**
 * spec: { title, volume, author, label, publisher, face, reading }
 * 返回 { el, setCover(url) }。el 带 .sp 类，外面再决定它是 3D 书的侧面还是预览。
 */
export function buildSpine(spec, cls = '') {
  const L = spec.label;
  const layout = L?.layout || 'plain';
  const face = spec.face === undefined ? parseFace('') : spec.face;
  const portrait = face && h('span.sp-face');
  const slot = { top: 0.36, gagaga: 0.34, fantasia: 0.38, legacy: 0.32, plain: 0.46 }[layout] - (portrait ? 0 : -0.06);
  const t = titleSize(vlen(spec.title), slot);
  const title = h('span.sp-title', { style: `--fs:${t.fs.toFixed(1)}cqw;--lines:${t.lines}` }, spec.title || '');
  const v = spec.volume != null && spec.volume !== '' ? String(spec.volume) : '';
  const vol = v && h('span.sp-vol' + (v.length > 2 ? '.is-long' : ''), v);
  const author = spec.author && h('span.sp-author', { style: `--fs:${Math.min(26, 1500 / Math.max(6, vlen(spec.author) * 9)).toFixed(1)}cqw` }, spec.author.split(/[、,，]/)[0]);
  const logo = L && logoUrl(L);
  const mark = (big) => (logo
    ? h('span.sp-mark.is-' + (L.mark || 'square') + (big ? '.is-big' : ''), h('img', { src: logo, alt: L.name, draggable: false, loading: 'lazy' }))
    : L && h('span.sp-mark.is-text', L.short || L.name));
  // 竖排的小字：按字数缩小，保证一列排得下
  const fit = (text, room, max) => `--fs:${Math.min(max, (room * SPINE_RATIO) / Math.max(1, vlen(text) * 1.12)).toFixed(1)}cqw`;
  const imprintText = (L?.short || L?.name || spec.publisher || '').replace(/（.*?）/g, '');
  const nameBox = imprintText && h('span.sp-imprint', { style: fit(imprintText, 11, 17) }, imprintText);
  const company = L && L.company !== imprintText && h('span.sp-company', { style: fit(L.company, 8, 13) }, L.company);

  let parts;
  if (layout === 'gagaga') parts = [mark(), title, vol, author, h('span.sp-gap'), portrait, company, nameBox];
  else if (layout === 'fantasia') parts = [h('span.sp-pad'), title, vol, mark(true), author, h('span.sp-gap'), nameBox];
  else if (layout === 'legacy') parts = [mark(), portrait, title, vol, author, h('span.sp-gap'), nameBox];
  else if (layout === 'top') parts = [mark(), portrait, title, vol, author, h('span.sp-gap'), nameBox];
  else parts = [h('span.sp-band'), portrait, title, vol, author, h('span.sp-gap'), nameBox];
  const el = h('div.sp' + (cls ? '.' + cls : '') + '.is-' + layout, h('div.sp-in', parts.filter(Boolean)), spec.reading && h('span.sp-ribbon'));
  return {
    el,
    setCover(url) { if (portrait && url) placePortrait(portrait, url, face); },
  };
}
