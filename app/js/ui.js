// 小型 DOM 工具：元素创建、图标、提示条、对话框。

export function h(spec, props, ...children) {
  const [tag, ...classes] = spec.split('.');
  const el = document.createElement(tag || 'div');
  if (classes.length) el.className = classes.join(' ');
  if (props && (typeof props !== 'object' || props instanceof Node || Array.isArray(props))) { children.unshift(props); props = null; }
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'html') el.innerHTML = v;
    else if (k in el && k !== 'list') { try { el[k] = v; } catch { el.setAttribute(k, v); } }
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : String(c));
  }
  return el;
}

const paths = {
  back: '<path d="M15 5l-7 7 7 7"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="M16 16l4.5 4.5"/>',
  more: '<circle cx="5" cy="12" r="1.3" fill="currentColor"/><circle cx="12" cy="12" r="1.3" fill="currentColor"/><circle cx="19" cy="12" r="1.3" fill="currentColor"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M12 2.8v2.4M12 18.8v2.4M2.8 12h2.4M18.8 12h2.4M5.5 5.5l1.7 1.7M16.8 16.8l1.7 1.7M5.5 18.5l1.7-1.7M16.8 7.2l1.7-1.7"/>',
  list: '<path d="M8 6h12M8 12h12M8 18h12"/><circle cx="4" cy="6" r="1" fill="currentColor"/><circle cx="4" cy="12" r="1" fill="currentColor"/><circle cx="4" cy="18" r="1" fill="currentColor"/>',
  type: '<path d="M4 19l5-14h1l5 14M6 14h7M16 19l2.5-7h.5l2.5 7M17 16.5h4"/>',
  sync: '<path d="M20 12a8 8 0 0 1-14.3 4.9M4 12a8 8 0 0 1 14.3-4.9"/><path d="M18.5 3v4.5H14M5.5 21v-4.5H10"/>',
  cloudOff: '<path d="M7 18a4.5 4.5 0 0 1-.8-8.9M10 6.5a6 6 0 0 1 8 4.6A3.5 3.5 0 0 1 18.5 18M3 3l18 18"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
  books: '<path d="M5 4h4v16H5zM10.5 4h4v16h-4zM16 6.2l3.6-1 3 13.6-3.6 1z" transform="translate(-1.5 0)"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7v5.5l3.5 2"/>',
  inbox: '<path d="M4 13l2.5-8h11L20 13v6H4zM4 13h5l1 2.5h4l1-2.5h5"/>',
  folder: '<path d="M3.5 7.5v10.5h17V8.5h-8.5l-2-2.5H3.5z"/>',
  down: '<path d="M12 4v12M7 11.5l5 5 5-5M5 20h14"/>',
  prev: '<path d="M14.5 6l-6 6 6 6"/>',
  next: '<path d="M9.5 6l6 6-6 6"/>',
  moon: '<path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2.5M12 19v2.5M2.5 12H5M19 12h2.5M5.3 5.3l1.8 1.8M16.9 16.9l1.8 1.8M5.3 18.7l1.8-1.8M16.9 7.1l1.8-1.8"/>',
  scroll: '<rect x="6" y="3" width="12" height="18" rx="2"/><path d="M12 8v8M9.5 13.5L12 16l2.5-2.5"/>',
  pages: '<rect x="3.5" y="5" width="7.5" height="14" rx="1"/><rect x="13" y="5" width="7.5" height="14" rx="1"/>',
};
export function icon(name, size = 20) {
  const span = document.createElement('span');
  span.className = 'icon';
  span.innerHTML = `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] || ''}</svg>`;
  return span;
}

// ---------- 提示条 ----------
let toastHost = null;
export function toast(message, { sticky = false, error = false } = {}) {
  if (!toastHost) { toastHost = h('div.toasts', { role: 'status', 'aria-live': 'polite' }); document.body.append(toastHost); }
  const el = h('div.toast' + (error ? '.is-error' : ''), message);
  toastHost.append(el);
  let timer = sticky ? null : setTimeout(close, error ? 5000 : 2600);
  function close() { clearTimeout(timer); el.remove(); }
  return {
    update(text) { el.textContent = text; },
    close,
    done(text, isError = false) {
      el.textContent = text; el.classList.toggle('is-error', isError);
      timer = setTimeout(close, isError ? 5000 : 2200);
    },
  };
}

// ---------- 对话框 ----------
/** 打开一个对话框。build(close) 返回内容节点；Promise 在关闭时给出 close(value) 的值。 */
export function dialog(title, build, { wide = false } = {}) {
  return new Promise((resolve) => {
    let result;
    const dlg = h('dialog.dialog' + (wide ? '.is-wide' : ''));
    const close = (value) => { result = value; dlg.close(); };
    dlg.append(
      h('header.dialog-head', h('h2', title),
        h('button.icon-btn', { type: 'button', 'aria-label': '关闭', onclick: () => close() }, icon('close'))),
      build(close),
    );
    dlg.addEventListener('click', (e) => { if (e.target === dlg) close(); });
    dlg.addEventListener('close', () => { dlg.remove(); resolve(result); });
    document.body.append(dlg);
    dlg.showModal();
  });
}

export function confirmDialog(title, message, { ok = '确定', danger = false } = {}) {
  return dialog(title, (close) => h('div.dialog-body',
    h('p.dialog-text', message),
    h('div.dialog-actions',
      h('button.btn', { type: 'button', onclick: () => close(false) }, '取消'),
      h('button.btn' + (danger ? '.is-danger' : '.is-primary'), { type: 'button', onclick: () => close(true) }, ok)),
  )).then(Boolean);
}

export function promptDialog(title, { label, value = '', ok = '保存', placeholder = '' } = {}) {
  return dialog(title, (close) => {
    const input = h('input.field', { type: 'text', value, placeholder, maxLength: 60, 'aria-label': label || title });
    setTimeout(() => { input.focus(); input.select(); }, 30);
    return h('form.dialog-body', { onsubmit: (e) => { e.preventDefault(); const v = input.value.trim(); if (v) close(v); } },
      label && h('label.field-label', label), input,
      h('div.dialog-actions',
        h('button.btn', { type: 'button', onclick: () => close() }, '取消'),
        h('button.btn.is-primary', { type: 'submit' }, ok)));
  });
}

/** 阅读器底部菜单里的一个按钮：图标在上，文字在下 */
export function menuButton(iconName, label, onclick) {
  return h('button.bottom-act', { type: 'button', onclick }, icon(iconName, 22), h('span', label));
}

export const fmtPercent = (p) => (p >= 0.995 ? '读完' : `${Math.max(1, Math.round(p * 100))}%`);
export function fmtSize(bytes) {
  if (bytes > 1 << 30) return (bytes / (1 << 30)).toFixed(1) + ' GB';
  if (bytes > 1 << 20) return (bytes / (1 << 20)).toFixed(1) + ' MB';
  return Math.max(1, Math.round(bytes / 1024)) + ' KB';
}
