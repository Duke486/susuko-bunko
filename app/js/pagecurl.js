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
    const { dark } = look();
    // ghost：没折起来的那部分纸（双页时加上另一边不动的那一页）。纸背由上面的层盖住，所以不用从这里挖掉；
    // 只有双页跨章节、没有纸背那一层时，才把纸背的位置挖空，让下面的新页透上来
    let d = pathOf(geo.unfolded);
    if (g.other) d += `M${g.other[0]} 0L${g.other[1]} 0L${g.other[1]} ${H}L${g.other[0]} ${H}Z`;
    const hole = !geo.flat && !g.backPaper && !g.useBack;
    ghost.style.clipPath = d ? (hole ? `path(evenodd, "${d}${pathOf(geo.flap)}")` : `path("${d}")`) : 'inset(50%)';
    // 双页的纸背：第三个书页显示翻过去以后的那一面。先沿书脊镜像、再沿折痕镜像，两次镜像合起来是一次旋转加平移
    if (g.useBack && back) {
      if (geo.flat || geo.folded.length < 3) back.style.clipPath = 'inset(50%)';
      else {
        const mirror = (q) => ({ u: -q.u, v: q.v });
        back.style.clipPath = `path("${pathOf(geo.folded.map(mirror))}")`;
        const ns = { x: g.s * geo.n.u, y: geo.n.v }, Ms = toScreen(geo.M);
        const R11 = 1 - 2 * ns.x * ns.x, R12 = -2 * ns.x * ns.y, R22 = 1 - 2 * ns.y * ns.y;
        const md = Ms.x * ns.x + Ms.y * ns.y, tx = 2 * md * ns.x, ty = 2 * md * ns.y;
        const bx = 2 * g.spineX;
        back.style.transform = `matrix(${-R11},${-R12},${R12},${R22},${R11 * bx + tx},${R12 * bx + ty})`;
      }
    }

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    if (geo.flat || geo.folded.length < 3) return;
    const k = dark ? 0.55 : 1;
    const open = Math.min(1, geo.dist / g.w); // 翻开的程度：影子跟着变宽变淡
    const grad = (from, len) => { // 从折痕出发，沿 n（指向原纸角，也就是露出新页的那一侧）走 len，len 为负就是往纸背那侧
      const p0 = toScreen({ u: geo.M.u + geo.n.u * from, v: geo.M.v + geo.n.v * from });
      const p1 = toScreen({ u: geo.M.u + geo.n.u * (from + len), v: geo.M.v + geo.n.v * (from + len) });
      return ctx.createLinearGradient(p0.x, p0.y, p1.x, p1.y);
    };
    const fillClipped = (poly, style, evenoddOuter = false) => {
      ctx.save(); ctx.beginPath();
      if (evenoddOuter) { ctx.rect(-W, -H, W * 3, H * 3); tracePoly(poly); ctx.clip('evenodd'); } else { tracePoly(poly); ctx.clip(); }
      ctx.fillStyle = style; ctx.fillRect(0, 0, W, H); ctx.restore();
    };

    // 光从左上方照下来。
    // 1. 没翻起来的那部分纸，靠近折痕的地方正往上弯，背着光，稍微暗一点
    let gr = grad(0, -(26 + 30 * open));
    gr.addColorStop(0, `rgba(0,0,0,${0.13 * k})`); gr.addColorStop(1, 'rgba(0,0,0,0)');
    fillClipped(geo.unfolded, gr);

    // 2. 露出来的新页上，翻起来的纸投下的影子：贴着折痕最深、边缘清楚，往外很快变淡
    const sw = 14 + 44 * open;
    gr = grad(0, sw);
    gr.addColorStop(0, `rgba(0,0,0,${0.42 * k})`);
    gr.addColorStop(0.18, `rgba(0,0,0,${0.2 * k})`);
    gr.addColorStop(0.55, `rgba(0,0,0,${0.06 * k})`);
    gr.addColorStop(1, 'rgba(0,0,0,0)');
    fillClipped(geo.folded, gr);

    // 3. 纸背投在下面纸上的影子：把纸背轮廓往右下错开几次叠出一圈软影（不用模糊滤镜，大窗口也不卡）
    ctx.save();
    ctx.beginPath(); ctx.rect(-W, -H, W * 3, H * 3); tracePoly(geo.flap); ctx.clip('evenodd');
    for (const [off, a] of [[2, 0.1], [5, 0.06], [9, 0.035]]) {
      ctx.beginPath();
      geo.flap.forEach((q, i) => { const p = toScreen(q); if (i) ctx.lineTo(p.x + off * 0.6, p.y + off); else ctx.moveTo(p.x + off * 0.6, p.y + off); });
      ctx.closePath(); ctx.fillStyle = `rgba(0,0,0,${a * k * (0.5 + open * 0.5)})`; ctx.fill();
    }
    ctx.restore();

    // 4. 纸背：单页时是纸的背面（纸色）；双页时纸背那一层已经在下面，只罩明暗
    let far = 1;
    for (const q of geo.flap) far = Math.max(far, -((q.u - geo.M.u) * geo.n.u + (q.v - geo.M.v) * geo.n.v));
    if (g.backPaper) fillClipped(geo.flap, look().paper);
    gr = grad(0, -far);
    const stop = (x) => Math.min(0.95, x / far);
    gr.addColorStop(0, `rgba(0,0,0,${0.22 * k})`);                      // 折痕：纸弯过来的地方最暗
    gr.addColorStop(stop(4), `rgba(0,0,0,${0.06 * k})`);
    gr.addColorStop(stop(12), `rgba(255,255,255,${dark ? 0.06 : 0.42})`); // 弯面朝着光，一道亮
    gr.addColorStop(stop(40), `rgba(255,255,255,${dark ? 0.02 : 0.12})`);
    gr.addColorStop(1, `rgba(0,0,0,${0.07 * k})`);                       // 纸边稍微压暗，看得出是一张纸
    fillClipped(geo.flap, gr);
    if (g.backPaper) fillClipped(geo.flap, dark ? 'rgba(255,255,255,0.02)' : 'rgba(80,60,30,0.03)');

    // 5. 纸边一道很细的线
    ctx.beginPath(); tracePoly(geo.flap);
    ctx.strokeStyle = `rgba(0,0,0,${0.12 * k})`; ctx.lineWidth = 0.6; ctx.stroke();
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
      drag.to = toLocal(x, y);
      if (drag.raf) return; // 一帧只画一次
      drag.raf = requestAnimationFrame(() => {
        if (!drag) return;
        drag.raf = 0;
        const q = drag.to;
        let u = drag.base.u + (q.u - drag.start.u) * drag.factor;
        // 手指水平拖时纸角也会自然地抬起来一点，折痕斜着，看起来才像纸
        const t = Math.min(1, Math.max(0, (C.u - u) / (2 * g.w)));
        const lift = H * 0.09 * Math.sin(Math.PI * t) * (C.v > H / 2 ? -1 : 1);
        P = constrain({ u, v: drag.base.v + (q.v - drag.start.v) * 0.55 + lift });
        draw();
      });
    },
    /** 已经翻过去多少：0 = 平放，1 = 完全翻过去 */
    turned() { return Math.min(1, Math.max(0, (C.u - P.u) / (2 * g.w))); },
    /** 自动翻到底（'done'）或者落回原位（'back'） */
    play(to, ms = 420) {
      if (drag?.raf) cancelAnimationFrame(drag.raf);
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
      if (drag?.raf) cancelAnimationFrame(drag.raf);
      active = false; drag = null;
      cv.hidden = true;
      ghost.style.visibility = '';
      ghost.style.clipPath = '';
      if (back) { back.style.visibility = ''; back.style.clipPath = ''; back.style.transform = ''; }
    },
  };
}
