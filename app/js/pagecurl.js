// 仿真翻页：把“正在翻的那张纸”画成被折起来的样子。
//
// 三层叠在一起：
//   live  —— 真正的书页 iframe，显示纸下面那一页
//   ghost —— 一个内容相同的 iframe，显示正在翻的那张纸；用 clip-path 只留下没被折起来的部分
//   canvas —— 折过来的纸背、折痕高光、投在下面书页上的阴影
//
// 几何：纸的“书脊”一侧固定，手指拖着纸角 P。折痕是纸角原位置 C 和 P 连线的垂直平分线；
// 折痕靠 C 那一侧的纸被折起来，沿折痕翻到另一侧（镜像）。纸不能被拉长，所以 P 离书脊角的距离不超过纸宽。
// 双页时纸背就是下一页的左半边——直接让 live 透过来，所以翻过去的那一面正好是新的一页。

export function createCurl({ ghost, back = null, look }) {
  const cv = document.createElement('canvas');
  cv.className = 'curl-canvas';
  cv.hidden = true;
  cv.setAttribute('aria-hidden', 'true');
  (back || ghost).after(cv);
  const ctx = cv.getContext('2d');

  let W = 0, H = 0, dpr = 1;
  let g = null; // { spineX, s, w, other: [x0, x1] | null, backPaper }
  let C = null, D = null, P = null;
  let drag = null, anim = null, active = false;

  // 本地坐标：u 从书脊往纸边增加，v 就是 y
  const toLocal = (x, y) => ({ u: g.s * (x - g.spineX), v: y });
  const toScreen = (q) => ({ x: g.spineX + g.s * q.u, y: q.v });

  function constrain(q) {
    const cy = C.v;
    const S = { u: 0, v: cy };
    let dx = q.u - S.u, dy = q.v - S.v, d = Math.hypot(dx, dy);
    if (d > g.w) q = { u: S.u + dx * g.w / d, v: S.v + dy * g.w / d };
    const S2 = { u: 0, v: H - cy }, diag = Math.hypot(g.w, H);
    dx = q.u - S2.u; dy = q.v - S2.v; d = Math.hypot(dx, dy);
    if (d > diag) q = { u: S2.u + dx * diag / d, v: S2.v + dy * diag / d };
    return q;
  }

  // 用一条直线把凸多边形切开，keep(f) 决定留哪边
  function clip(poly, f, keepPos) {
    const out = [];
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i], b = poly[(i + 1) % poly.length];
      const fa = f(a), fb = f(b);
      const ina = keepPos ? fa > 0 : fa <= 0, inb = keepPos ? fb > 0 : fb <= 0;
      if (ina) out.push(a);
      if (ina !== inb) { const t = fa / (fa - fb); out.push({ u: a.u + (b.u - a.u) * t, v: a.v + (b.v - a.v) * t }); }
    }
    return out;
  }

  function geometry() {
    const dist = Math.hypot(C.u - P.u, C.v - P.v);
    const sheet = [{ u: 0, v: 0 }, { u: g.w, v: 0 }, { u: g.w, v: H }, { u: 0, v: H }];
    if (dist < 0.5) return { flat: true, unfolded: sheet, folded: [], flap: [] };
    const M = { u: (C.u + P.u) / 2, v: (C.v + P.v) / 2 };
    const n = { u: (C.u - P.u) / dist, v: (C.v - P.v) / dist };
    const side = (q) => (q.u - M.u) * n.u + (q.v - M.v) * n.v;
    const folded = clip(sheet, side, true);
    const unfolded = clip(sheet, side, false);
    const flap = folded.map((q) => { const k = 2 * side(q); return { u: q.u - k * n.u, v: q.v - k * n.v }; });
    return { flat: false, M, n, unfolded, folded, flap, dist };
  }

  const pathOf = (poly) => (poly.length < 3 ? '' : 'M' + poly.map((q) => { const p = toScreen(q); return `${p.x.toFixed(1)} ${p.y.toFixed(1)}`; }).join('L') + 'Z');
  const tracePoly = (poly, off = 0) => {
    poly.forEach((q, i) => { const p = toScreen(q); if (i) ctx.lineTo(p.x + off, p.y); else ctx.moveTo(p.x + off, p.y); });
    ctx.closePath();
  };

  function draw() {
    const geo = geometry();
    const { paper, dark } = look();
    // ghost：没折起来的那部分纸（加上双页时另一边不动的那一页），减掉盖在上面的纸背
    let d = pathOf(geo.unfolded);
    if (g.other) d += `M${g.other[0]} 0L${g.other[1]} 0L${g.other[1]} ${H}L${g.other[0]} ${H}Z`;
    if (!geo.flat) d += pathOf(geo.flap);
    ghost.style.clipPath = d ? `path(evenodd, "${d}")` : 'inset(50%)';
    // 双页的纸背：第三个书页显示翻过去以后的那一面。先沿书脊镜像、再沿折痕镜像，两次镜像合起来是一次旋转加平移
    if (g.useBack && back) {
      if (geo.flat || geo.folded.length < 3) back.style.clipPath = 'inset(50%)';
      else {
        const mirror = (q) => ({ u: -q.u, v: q.v }); // 纸背上的点：先镜像到书脊另一侧
        back.style.clipPath = `path("${pathOf(geo.folded.map(mirror))}")`;
        const ns = { x: g.s * geo.n.u, y: geo.n.v }, Ms = toScreen(geo.M);
        const R11 = 1 - 2 * ns.x * ns.x, R12 = -2 * ns.x * ns.y, R22 = 1 - 2 * ns.y * ns.y;
        const md = Ms.x * ns.x + Ms.y * ns.y, tx = 2 * md * ns.x, ty = 2 * md * ns.y;
        const bx = 2 * g.spineX; // 书脊镜像：x → 2·spineX − x
        back.style.transform = `matrix(${-R11},${-R12},${R12},${R22},${R11 * bx + tx},${R12 * bx + ty})`;
      }
    }

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    if (geo.flat || geo.folded.length < 3) return;
    const k = dark ? 0.6 : 1;
    const lift = Math.min(1, geo.dist / (g.w * 0.9)); // 翻得越开，阴影越重、越宽
    const toward = (len, a = 0) => { // 折痕上一点，沿 n（指向原纸角）走 len
      const p0 = toScreen(geo.M), p1 = toScreen({ u: geo.M.u + geo.n.u * len, v: geo.M.v + geo.n.v * len });
      return ctx.createLinearGradient(p0.x, p0.y, p1.x, p1.y);
    };

    // 1. 露出来的下一页上，靠折痕的地方被翻起的纸挡住光
    ctx.save();
    ctx.beginPath(); tracePoly(geo.folded); ctx.clip();
    const sw = 18 + 46 * lift;
    let gr = toward(sw);
    gr.addColorStop(0, `rgba(0,0,0,${0.32 * k})`);
    gr.addColorStop(0.35, `rgba(0,0,0,${0.12 * k})`);
    gr.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = gr; ctx.fillRect(0, 0, W, H);
    ctx.restore();

    // 2. 纸背投在没翻的纸上的影子（只画影子不画纸：把纸挪出画面，影子偏移回来）
    const OFF = 20000;
    ctx.save();
    ctx.beginPath(); ctx.rect(0, 0, W, H); tracePoly(geo.flap); ctx.clip('evenodd');
    ctx.shadowColor = `rgba(0,0,0,${0.38 * k})`;
    ctx.shadowBlur = (10 + 16 * lift) * dpr;
    ctx.shadowOffsetX = OFF * dpr;
    ctx.beginPath(); tracePoly(geo.flap, -OFF); ctx.fillStyle = '#000'; ctx.fill();
    ctx.restore();

    // 3. 纸背：单页时是纸的背面；双页时是下一页，只罩一层弯曲的明暗
    ctx.save();
    ctx.beginPath(); tracePoly(geo.flap); ctx.clip();
    if (g.backPaper) { ctx.fillStyle = paper; ctx.fillRect(0, 0, W, H); }
    let far = 0;
    for (const q of geo.flap) far = Math.max(far, -((q.u - geo.M.u) * geo.n.u + (q.v - geo.M.v) * geo.n.v));
    far = Math.max(far, 1);
    gr = toward(-far);
    const a = g.backPaper ? 1 : 0.75;
    gr.addColorStop(0, `rgba(0,0,0,${0.16 * k * a})`);
    gr.addColorStop(Math.min(0.5, 14 / far), `rgba(255,255,255,${(dark ? 0.05 : 0.28) * a})`); // 折痕附近的高光
    gr.addColorStop(Math.min(0.8, 60 / far), `rgba(0,0,0,${0.02 * a})`);
    gr.addColorStop(1, `rgba(0,0,0,${0.1 * k * a})`);
    ctx.fillStyle = gr; ctx.fillRect(0, 0, W, H);
    if (g.backPaper) { // 背面透出一点点正面的字的颜色，像真的纸
      ctx.fillStyle = dark ? 'rgba(255,255,255,0.025)' : 'rgba(60,40,20,0.035)';
      ctx.fillRect(0, 0, W, H);
    }
    ctx.restore();

    // 4. 纸边细线
    ctx.beginPath(); tracePoly(geo.flap);
    ctx.strokeStyle = `rgba(0,0,0,${0.14 * k})`; ctx.lineWidth = 0.8; ctx.stroke();
  }

  function size(w, h) {
    W = w; H = h; dpr = Math.min(2, window.devicePixelRatio || 1);
    cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
    cv.style.width = W + 'px'; cv.style.height = H + 'px';
  }

  return {
    get active() { return active; },
    /** 开始一次翻页。geom：{ spineX, s, w, other, backPaper }；top：从上面的纸角翻 */
    begin(w, h, geom, { top = false, fromDone = false } = {}) {
      anim?.cancel?.();
      g = geom; size(w, h);
      C = { u: g.w, v: top ? 0 : H };
      D = { u: -g.w, v: C.v };
      P = fromDone ? { ...D } : { ...C };
      active = true;
      ghost.style.visibility = 'visible';
      if (back && g.useBack) back.style.visibility = 'visible';
      cv.hidden = false;
      draw();
    },
    dragStart(x, y, factor = 1.35) { drag = { start: toLocal(x, y), base: { ...P }, factor }; },
    dragTo(x, y) {
      if (!drag) return;
      const q = toLocal(x, y);
      P = constrain({ u: drag.base.u + (q.u - drag.start.u) * drag.factor, v: drag.base.v + (q.v - drag.start.v) * 0.55 });
      draw();
    },
    /** 已经翻过去多少：0 = 平放，1 = 完全翻过去 */
    turned() { return Math.min(1, Math.max(0, (C.u - P.u) / (2 * g.w))); },
    /** 自动翻到底（'done'）或者落回原位（'back'） */
    play(to, ms = 420) {
      drag = null;
      const from = { ...P }, target = to === 'done' ? D : C;
      const remain = Math.abs(target.u - from.u) / (2 * g.w);
      const dur = Math.max(140, ms * (0.35 + 0.65 * remain));
      const arc = H * 0.14 * remain * (C.v > H / 2 ? -1 : 1); // 自动翻时纸角走一道弧线，看起来更像在翻纸
      const t0 = performance.now();
      return new Promise((resolve) => {
        let raf = 0;
        const step = (now) => {
          const t = Math.min(1, (now - t0) / dur);
          const e = 1 - (1 - t) ** 3;
          P = constrain({ u: from.u + (target.u - from.u) * e, v: from.v + (target.v - from.v) * e + arc * Math.sin(Math.PI * e) });
          draw();
          if (t < 1) raf = requestAnimationFrame(step); else { anim = null; resolve(true); }
        };
        raf = requestAnimationFrame(step);
        anim = { cancel: () => { cancelAnimationFrame(raf); anim = null; resolve(false); } };
      });
    },
    end() {
      anim?.cancel?.();
      active = false; drag = null;
      cv.hidden = true;
      ghost.style.visibility = '';
      ghost.style.clipPath = '';
      if (back) { back.style.visibility = ''; back.style.clipPath = ''; back.style.transform = ''; }
    },
  };
}
