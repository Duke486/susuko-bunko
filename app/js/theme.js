// 主题色：从一个主色推出整套界面色调（背景、玻璃、文字、分隔线、强调色），深浅色各一套。
// 在 OKLCH 色彩空间里算，换主色时明暗层次保持一致，只有色相和浓淡跟着变。
import { prefs } from './store.js';

// 预设主色（スス子文庫自己的配色）
export const PRESETS = [
  { id: 'sakura', name: '樱吹雪', color: '#E46F93' },
  { id: 'sora', name: '夏空', color: '#3E86D8' },
  { id: 'matcha', name: '抹茶', color: '#5E9157' },
  { id: 'yuyake', name: '夕烧', color: '#D9693B' },
  { id: 'ajisai', name: '紫阳花', color: '#7D6BC9' },
  { id: 'sumi', name: '墨染', color: '#4E5868' },
];

// ---------- 色彩换算 ----------
const toLin = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const toSrgb = (c) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);
export function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
const rgbToHex = (rgb) => '#' + rgb.map((v) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, '0')).join('');

export function hexToOklch(hex) {
  const [R, G, B] = hexToRgb(hex).map((v) => toLin(v / 255));
  const l = Math.cbrt(0.4122214708 * R + 0.5363325363 * G + 0.0514459929 * B);
  const m = Math.cbrt(0.2119034982 * R + 0.6806995451 * G + 0.1073969566 * B);
  const s = Math.cbrt(0.0883024619 * R + 0.2817188376 * G + 0.6299787005 * B);
  const L = 0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s;
  const a = 1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s;
  const b = 0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s;
  return { L, C: Math.hypot(a, b), h: ((Math.atan2(b, a) * 180) / Math.PI + 360) % 360 };
}
function oklchToRgb(L, C, h) {
  const a = C * Math.cos((h * Math.PI) / 180), b = C * Math.sin((h * Math.PI) / 180);
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.2914855480 * b) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s,
  ];
}
/** 书脊用的颜色：在封面主色的基础上提一点浓度、把明暗收在中间，书架上才不会一片灰蒙蒙 */
export function spineTone(hex) {
  const { L, C, h } = hexToOklch(hex);
  if (C < 0.035) return oklch(Math.min(0.78, Math.max(0.36, L)), C, h); // 本来就是黑白灰的封面不硬加颜色
  return oklch(Math.min(0.74, Math.max(0.46, L)), Math.min(0.2, Math.max(0.12, C * 1.25)), h);
}
/** OKLCH → 十六进制；超出屏幕能显示的范围时逐步降低浓度 */
export function oklch(L, C, h) {
  for (let c = C; c >= 0; c -= 0.005) {
    const rgb = oklchToRgb(L, c, h);
    if (rgb.every((v) => v >= -0.0005 && v <= 1.0005)) return rgbToHex(rgb.map((v) => toSrgb(Math.min(1, Math.max(0, v))) * 255));
  }
  return rgbToHex(oklchToRgb(L, 0, h).map((v) => toSrgb(Math.min(1, Math.max(0, v))) * 255));
}
const alpha = (hex, a) => { const [r, g, b] = hexToRgb(hex); return `rgba(${r}, ${g}, ${b}, ${a})`; };

/** 由主色生成整套界面变量 */
export function palette(seed, dark) {
  const { L, C, h } = hexToOklch(seed);
  const c = (k, max) => Math.min(C * k, max);
  if (!dark) {
    const surface = oklch(0.995, c(0.05, 0.006), h);
    return {
      '--accent': oklch(Math.min(0.66, Math.max(0.5, L)), Math.min(C, 0.17), h),
      '--pink': oklch(Math.min(0.68, Math.max(0.55, L)), Math.min(C, 0.17), h),
      '--ribbon': oklch(0.58, Math.min(C, 0.17), h),
      '--bg': oklch(0.955, c(0.22, 0.025), h),
      '--surface': surface,
      '--glass': alpha(surface, 0.62),
      '--ink': oklch(0.27, c(0.2, 0.035), h),
      '--muted': oklch(0.53, c(0.25, 0.035), h),
      '--line': oklch(0.885, c(0.2, 0.025), h),
      '--wash': `radial-gradient(1100px 620px at -5% -10%, ${oklch(0.9, c(0.5, 0.065), h)} 0%, transparent 62%), radial-gradient(900px 700px at 105% 0%, ${oklch(0.92, c(0.4, 0.05), h + 45)} 0%, transparent 58%), radial-gradient(900px 600px at 50% 115%, ${oklch(0.93, c(0.3, 0.04), h - 40)} 0%, transparent 60%)`,
    };
  }
  const surface = oklch(0.23, c(0.12, 0.018), h);
  return {
    '--accent': oklch(0.74, Math.min(C, 0.14), h),
    '--pink': oklch(0.75, Math.min(C, 0.14), h),
    '--ribbon': oklch(0.7, Math.min(C, 0.14), h),
    '--bg': oklch(0.175, c(0.12, 0.016), h),
    '--surface': surface,
    '--glass': alpha(surface, 0.6),
    '--ink': oklch(0.93, c(0.05, 0.012), h),
    '--muted': oklch(0.7, c(0.15, 0.025), h),
    '--line': oklch(0.32, c(0.15, 0.022), h),
    '--wash': `radial-gradient(1100px 620px at -5% -10%, ${oklch(0.27, c(0.4, 0.05), h)} 0%, transparent 62%), radial-gradient(900px 700px at 105% 0%, ${oklch(0.26, c(0.35, 0.045), h + 45)} 0%, transparent 58%)`,
  };
}

// ---------- 取色 ----------
/** 从图片里挑一个有代表性、又足够鲜明的颜色当主色 */
export async function extractColor(source) {
  const bmp = await createImageBitmap(source);
  const canvas = document.createElement('canvas');
  canvas.width = 48; canvas.height = 48;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bmp, 0, 0, 48, 48);
  bmp.close?.();
  const data = ctx.getImageData(0, 0, 48, 48).data;
  const bins = new Map(); // 按色相分 24 格，统计每格的像素数和平均颜色
  let grey = [0, 0, 0, 0];
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] < 128) continue;
    const hex = rgbToHex([data[i], data[i + 1], data[i + 2]]);
    const { L, C, h } = hexToOklch(hex);
    if (L < 0.18 || L > 0.96) continue;
    if (L > 0.8 && C < 0.09 && h > 20 && h < 90) continue; // 浅肤色：插画封面里到处都是，取出来书脊就都是一个色
    if (C < 0.04) { grey = [grey[0] + data[i], grey[1] + data[i + 1], grey[2] + data[i + 2], grey[3] + 1]; continue; }
    const k = Math.floor(h / 15);
    const b = bins.get(k) || { n: 0, c: 0, r: 0, g: 0, bl: 0 };
    b.n++; b.c += C; b.r += data[i]; b.g += data[i + 1]; b.bl += data[i + 2];
    bins.set(k, b);
  }
  let best = null, score = 0;
  for (const b of bins.values()) {
    const s = b.n * (b.c / b.n) ** 2.2; // 鲜艳的颜色优先，哪怕面积小一点
    if (s > score) { score = s; best = b; }
  }
  if (best && best.n > 20) return rgbToHex([best.r / best.n, best.g / best.n, best.bl / best.n]);
  if (grey[3]) return rgbToHex([grey[0] / grey[3], grey[1] / grey[3], grey[2] / grey[3]]);
  return '#4E5868';
}

// ---------- 应用 ----------
// prefs 'accent'：{ mode: 'default' | 'preset' | 'custom' | 'image' | 'cover', color }
export const accentSettings = () => ({ mode: 'default', color: '', ...prefs.get('accent', {}) });
export function saveAccent(patch) { prefs.set('accent', { ...accentSettings(), ...patch }); applyAccent(); }
const VARS = ['--accent', '--pink', '--ribbon', '--bg', '--surface', '--glass', '--ink', '--muted', '--line', '--wash'];
export function applyAccent() {
  const a = accentSettings();
  const root = document.documentElement;
  if (a.mode === 'default' || !hexToRgb(a.color)) { for (const v of VARS) root.style.removeProperty(v); return; }
  const vars = palette(a.color, root.dataset.theme === 'dark');
  for (const [k, v] of Object.entries(vars)) root.style.setProperty(k, v);
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.content = vars['--bg'];
}
