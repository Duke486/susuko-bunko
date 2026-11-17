// 书脊：照着日本文库本书脊的结构排——顶上文库小标，人物小图，竖排书名，卷号，作者，最下面文库名。
// 文字大小都用书脊自己的宽高（容器单位 cqw / cqh）来算，所以 3D 书架上大小怎么变，比例都一样。
import { h } from './ui.js';
import { logoUrl } from './labels.js';

export const SPINE_RATIO = 7.1; // 书脊高 ÷ 宽（书 1 : 1.42，厚度是宽的 0.2）
const H = SPINE_RATIO * 100; // 书脊高度，单位 cqw（宽度的百分之一）
const GAP = 2.2 * SPINE_RATIO; // 各块之间的空隙（2.2cqh）

const vlen = (s) => [...String(s || '')].reduce((n, ch) => n + (/[\x20-\x7e]/.test(ch) ? 0.55 : 1), 0);

// 书名一定要排得下：在剩下的高度里，找出能把整个书名放进去的最大字号（可以分几列竖排）
function titleFit(len, room) {
  for (let fs = 58; fs >= 9; fs -= 0.5) {
    const perCol = Math.floor(room / (fs * 1.02));
    if (perCol < 1) continue;
    const cols = Math.ceil(len / perCol);
    if (cols * fs * 1.1 <= 90) return fs;
  }
  return 9;
}
// 一列竖排的小字：按字数缩小，保证排得下
const fitCol = (len, room, max) => Math.min(max, room / Math.max(1, len * 1.06));

/**
 * spec: { title, volume, author, label, publisher, reading }
 * 返回 { el }。el 带 .sp 类，外面再决定它是 3D 书的侧面还是预览。
 */
export function buildSpine(spec, cls = '') {
  const L = spec.label;
  const layout = L?.layout || 'plain';
  const logo = L && logoUrl(L);
  const v = spec.volume != null && spec.volume !== '' ? String(spec.volume) : '';
  const authorText = (spec.author || '').split(/[、,，]/)[0].trim();
  const imprintText = (L?.short || L?.name || spec.publisher || '').replace(/（.*?）/g, '');
  const companyText = L && layout === 'gagaga' && L.company !== imprintText ? L.company : '';

  // 先把书名以外的部分量好，剩下的高度都给书名
  const aFs = authorText ? fitCol(vlen(authorText), 120, 26) : 0;
  const iFs = imprintText ? fitCol(vlen(imprintText), 84, 17) : 0;
  const cFs = companyText ? fitCol(vlen(companyText), 56, 13) : 0;
  const markH = !L ? 36 : !logo ? Math.min(100, vlen(L.short || L.name) * 21 + 16) : { square: 78, wide: 43, light: 57 }[L.mark] || 78;
  const used = [
    layout === 'fantasia' ? 14 + 74 : layout === 'legacy' ? 64 + 21 : markH, // 顶上的小标（Fantasia 的圆标在中间）
    v ? 48 : 0,
    authorText ? vlen(authorText) * aFs * 1.06 : 0,
    imprintText ? vlen(imprintText) * iFs * 1.12 + 22 : 0,
    companyText ? vlen(companyText) * cFs + 4 : 0,
  ];
  const items = used.filter(Boolean).length + 1;
  const room = H - used.reduce((a, b) => a + b, 0) - GAP * (items + 1) - 24;
  const title = h('span.sp-title', { style: `--fs:${titleFit(vlen(spec.title), Math.max(80, room)).toFixed(1)}cqw` }, spec.title || '');
  const vol = v && h('span.sp-vol' + (v.length > 2 ? '.is-long' : ''), v);
  const author = authorText && h('span.sp-author', { style: `--fs:${aFs.toFixed(1)}cqw` }, authorText);
  const mark = (big) => (logo
    ? h('span.sp-mark.is-' + (L.mark || 'square') + (big ? '.is-big' : ''), h('img', { src: logo, alt: L.name, draggable: false, loading: 'lazy' }))
    : L && h('span.sp-mark.is-text', { style: `--fs:${fitCol(vlen(L.short || L.name), 84, 20).toFixed(1)}cqw` }, L.short || L.name));
  const nameBox = imprintText && h('span.sp-imprint', { style: `--fs:${iFs.toFixed(1)}cqw` }, imprintText);
  const company = companyText && h('span.sp-company', { style: `--fs:${cFs.toFixed(1)}cqw` }, companyText);

  let parts;
  if (layout === 'gagaga') parts = [mark(), title, vol, author, h('span.sp-gap'), company, nameBox];
  else if (layout === 'fantasia') parts = [h('span.sp-pad'), title, vol, mark(true), author, h('span.sp-gap'), nameBox];
  else if (layout === 'plain') parts = [h('span.sp-band'), title, vol, author, h('span.sp-gap'), nameBox];
  else parts = [mark(), title, vol, author, h('span.sp-gap'), nameBox];
  const el = h('div.sp' + (cls ? '.' + cls : '') + '.is-' + layout, h('div.sp-in', parts.filter(Boolean)), spec.reading && h('span.sp-ribbon'));
  return { el };
}

/** 在书脊真正显示出来以后量一次：找出能把整个书名排进去的最大字号。
 *  字号用的是书脊宽度的百分比，所以量一次以后书架怎么缩放都不用再量。 */
export function fitSpine(el) {
  const inner = el.querySelector('.sp-in'), title = el.querySelector('.sp-title');
  if (!inner || !title || !el.clientHeight || el.dataset.fitted) return;
  const fits = (fs) => {
    title.style.setProperty('--fs', `${fs}cqw`);
    return inner.scrollHeight <= inner.clientHeight + 1 && title.scrollWidth <= el.clientWidth * 0.94 && title.scrollHeight <= title.clientHeight + 1;
  };
  let lo = 6, hi = 58;
  if (fits(hi)) lo = hi;
  else {
    for (let k = 0; k < 9; k++) { const mid = (lo + hi) / 2; if (fits(mid)) lo = mid; else hi = mid; }
  }
  title.style.setProperty('--fs', `${lo.toFixed(1)}cqw`);
  el.dataset.fitted = '1';
}
