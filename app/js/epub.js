// EPUB 解析：元数据、封面、书脊（spine）、目录，以及把单章处理成可放进 iframe 的文档。
import { ZipReader, mimeOf } from './zip.js';

const XHTML = 'http://www.w3.org/1999/xhtml';
const XLINK = 'http://www.w3.org/1999/xlink';

function resolvePath(base, rel) {
  try {
    const u = new URL(rel, 'http://e/' + base.split('/').map(encodeURIComponent).join('/'));
    return { path: decodeURIComponent(u.pathname.slice(1)), hash: decodeURIComponent(u.hash.slice(1)) };
  } catch { return { path: rel, hash: '' }; }
}
const parseXml = (text) => new DOMParser().parseFromString(text, 'application/xml');
const byTag = (root, name) => [...root.getElementsByTagNameNS('*', name)];

export class Epub {
  static async open(blob) {
    const book = new Epub();
    book.zip = await ZipReader.open(blob);
    await book._readPackage();
    return book;
  }

  constructor() {
    this.urls = new Map(); // 资源路径 -> blob URL
    this.chapterUrls = [];
  }

  async _readPackage() {
    const container = parseXml(await this.zip.text('META-INF/container.xml'));
    const rootfile = byTag(container, 'rootfile')[0];
    if (!rootfile) throw new Error('EPUB 缺少 container.xml 入口');
    this.opfPath = rootfile.getAttribute('full-path');
    const opf = parseXml(await this.zip.text(this.opfPath));

    const text = (name) => (byTag(opf, name)[0]?.textContent || '').trim();
    this.title = text('title');
    // 作者与插画师：角色写在 opf:role 属性（EPUB2）或 refines 的 meta（EPUB3）里，ill = 插画
    const roleOf = (n) => {
      const direct = n.getAttribute('opf:role') || n.getAttributeNS('http://www.idpf.org/2007/opf', 'role');
      if (direct) return direct;
      const id = n.getAttribute('id');
      const refine = id && byTag(opf, 'meta').find((m) => m.getAttribute('refines') === '#' + id && m.getAttribute('property') === 'role');
      return refine ? refine.textContent.trim() : '';
    };
    const people = [...byTag(opf, 'creator'), ...byTag(opf, 'contributor')]
      .map((n) => ({ name: n.textContent.trim(), role: roleOf(n), creator: n.localName === 'creator' })).filter((x) => x.name);
    this.author = people.filter((x) => x.creator && x.role !== 'ill').map((x) => x.name).join('、');
    this.illustrator = people.filter((x) => x.role === 'ill').map((x) => x.name).join('、');
    this.language = text('language');
    this.publisher = text('publisher');
    // 简介：dc:description 里常常是转义过的 HTML，转成纯文本并保留分段
    const rawDesc = text('description');
    if (rawDesc) {
      const html = rawDesc.replace(/<\s*(br|\/p|\/div|\/li)[^>]*>/gi, '\n');
      const plain = new DOMParser().parseFromString(html, 'text/html').body.textContent || '';
      this.description = plain.split('\n').map((l) => l.trim()).filter(Boolean).join('\n').slice(0, 8000);
    } else this.description = '';
    // 系列与卷号：Calibre 写法或 EPUB3 的 belongs-to-collection
    const metas = byTag(opf, 'meta');
    const named = (n) => metas.find((m) => m.getAttribute('name') === n)?.getAttribute('content') || '';
    const prop = (n) => (metas.find((m) => m.getAttribute('property') === n)?.textContent || '').trim();
    this.series = named('calibre:series') || prop('belongs-to-collection');
    const pos = parseFloat(named('calibre:series_index') || prop('group-position'));
    this.volume = this.series && Number.isFinite(pos) ? pos : null;

    this.manifest = new Map();
    this.byPath = new Map();
    for (const it of byTag(opf, 'item')) {
      const item = {
        id: it.getAttribute('id'),
        path: resolvePath(this.opfPath, it.getAttribute('href') || '').path,
        type: it.getAttribute('media-type') || '',
        props: (it.getAttribute('properties') || '').split(/\s+/),
      };
      this.manifest.set(item.id, item);
      this.byPath.set(item.path, item);
    }

    const spineEl = byTag(opf, 'spine')[0];
    this.spine = byTag(opf, 'itemref')
      .map((ref) => this.manifest.get(ref.getAttribute('idref')))
      .filter((it) => it && this.zip.get(it.path))
      .map((it) => ({ path: it.path, size: Math.max(1, this.zip.get(it.path).size) }));
    if (!this.spine.length) throw new Error('这本 EPUB 没有可读的正文');
    this.totalSize = this.spine.reduce((s, c) => s + c.size, 0);

    // 封面
    let cover = [...this.manifest.values()].find((it) => it.props.includes('cover-image'));
    if (!cover) {
      const meta = byTag(opf, 'meta').find((m) => m.getAttribute('name') === 'cover');
      cover = meta && this.manifest.get(meta.getAttribute('content'));
    }
    if (!cover) {
      cover = [...this.manifest.values()].find((it) => it.type.startsWith('image/') && /cover/i.test(it.id + it.path));
    }
    this.coverPath = cover && cover.type.startsWith('image/') && this.zip.get(cover.path) ? cover.path : null;

    // 目录：优先 EPUB3 nav，其次 NCX
    this.toc = [];
    try {
      const nav = [...this.manifest.values()].find((it) => it.props.includes('nav'));
      if (nav) this.toc = await this._readNav(nav.path);
      if (!this.toc.length) {
        const ncx = this.manifest.get(spineEl?.getAttribute('toc')) ||
          [...this.manifest.values()].find((it) => it.type === 'application/x-dtbncx+xml');
        if (ncx) this.toc = await this._readNcx(ncx.path);
      }
    } catch { /* 目录坏了不影响阅读 */ }
  }

  _tocEntry(base, label, href, depth) {
    const { path, hash } = resolvePath(base, href);
    const index = this.spine.findIndex((c) => c.path === path);
    return index < 0 ? null : { label: label.replace(/\s+/g, ' ').trim() || '（无标题）', index, hash, depth };
  }

  async _readNav(path) {
    const doc = parseXml(await this.zip.text(path));
    const navs = byTag(doc, 'nav');
    const nav = navs.find((n) => (n.getAttributeNS('http://www.idpf.org/2007/ops', 'type') || n.getAttribute('epub:type')) === 'toc') || navs[0];
    if (!nav) return [];
    const out = [];
    const walk = (ol, depth) => {
      for (const li of ol.children) {
        if (li.localName !== 'li') continue;
        const a = [...li.children].find((c) => c.localName === 'a');
        if (a) { const e = this._tocEntry(path, a.textContent, a.getAttribute('href') || '', depth); if (e) out.push(e); }
        const sub = [...li.children].find((c) => c.localName === 'ol');
        if (sub) walk(sub, depth + 1);
      }
    };
    const ol = [...nav.children].find((c) => c.localName === 'ol');
    if (ol) walk(ol, 0);
    return out;
  }

  async _readNcx(path) {
    const doc = parseXml(await this.zip.text(path));
    const out = [];
    const walk = (parent, depth) => {
      for (const np of parent.children) {
        if (np.localName !== 'navPoint') continue;
        const label = byTag(np, 'text')[0]?.textContent || '';
        const src = [...np.children].find((c) => c.localName === 'content')?.getAttribute('src') || '';
        const e = this._tocEntry(path, label, src, depth); if (e) out.push(e);
        walk(np, depth + 1);
      }
    };
    const map = byTag(doc, 'navMap')[0];
    if (map) walk(map, 0);
    return out;
  }

  async coverBlob() {
    if (this.coverPath) return this.zip.blobOf(this.coverPath, mimeOf(this.coverPath));
    return null;
  }

  // ---- 资源 ----
  async _resourceUrl(path) {
    if (this.urls.has(path)) return this.urls.get(path);
    const entry = this.zip.get(path);
    if (!entry) return '';
    const type = this.byPath.get(path)?.type || mimeOf(path);
    const p = this.zip.blobOf(entry, type).then((b) => URL.createObjectURL(b));
    this.urls.set(path, p);
    return p;
  }

  async _processCss(css, base, depth = 0) {
    // @import 内联
    const imports = [...css.matchAll(/@import\s+(?:url\(\s*)?["']?([^"')\s;]+)["']?\s*\)?[^;]*;/g)];
    for (const m of imports) {
      let inlined = '';
      const { path } = resolvePath(base, m[1]);
      if (depth < 3 && this.zip.get(path)) inlined = await this._processCss(await this.zip.text(path), path, depth + 1);
      css = css.replace(m[0], inlined);
    }
    const refs = [...css.matchAll(/url\(\s*(["']?)([^"')]+)\1\s*\)/g)];
    for (const m of refs) {
      if (/^(data:|blob:|https?:|#)/i.test(m[2])) continue;
      const url = await this._resourceUrl(resolvePath(base, m[2]).path);
      css = css.replace(m[0], `url("${url}")`);
    }
    return css;
  }

  /** 把第 index 章处理成 blob URL。readerCss 会以 <style id="shiori-style"> 注入。 */
  async chapter(index, readerCss) {
    const { path } = this.spine[index];
    const source = await this.zip.text(path);
    let doc = new DOMParser().parseFromString(source, 'application/xhtml+xml');
    let isXml = true;
    if (doc.getElementsByTagName('parsererror').length || !doc.documentElement || doc.documentElement.localName !== 'html') {
      doc = new DOMParser().parseFromString(source, 'text/html');
      isXml = false;
    }
    const make = (name) => (isXml ? doc.createElementNS(XHTML, name) : doc.createElement(name));

    // 书里的脚本一律不执行
    for (const el of doc.querySelectorAll('script, iframe, object, embed, base, meta[http-equiv]')) el.remove();
    for (const el of doc.querySelectorAll('*')) {
      for (const attr of [...el.attributes]) {
        if (/^on/i.test(attr.name)) el.removeAttribute(attr.name);
        else if (/^(href|src)$/i.test(attr.localName) && /^\s*javascript:/i.test(attr.value)) el.removeAttribute(attr.name);
      }
    }

    const jobs = [];
    const rewrite = (el, get, set) => {
      const v = get();
      if (!v || /^(data:|blob:|https?:)/i.test(v)) return;
      jobs.push(this._resourceUrl(resolvePath(path, v).path).then((u) => set(u)));
    };
    for (const el of doc.querySelectorAll('img, source, video, audio')) {
      if (el.hasAttribute('src')) rewrite(el, () => el.getAttribute('src'), (u) => el.setAttribute('src', u));
      el.removeAttribute('srcset');
    }
    for (const el of doc.getElementsByTagNameNS('*', 'image')) { // SVG 整页插画
      if (el.hasAttributeNS(XLINK, 'href')) rewrite(el, () => el.getAttributeNS(XLINK, 'href'), (u) => el.setAttributeNS(XLINK, 'xlink:href', u));
      else if (el.hasAttribute('xlink:href')) rewrite(el, () => el.getAttribute('xlink:href'), (u) => el.setAttribute('xlink:href', u));
      if (el.hasAttribute('href')) rewrite(el, () => el.getAttribute('href'), (u) => el.setAttribute('href', u));
    }
    for (const link of [...doc.querySelectorAll('link')]) {
      const rel = (link.getAttribute('rel') || '').toLowerCase();
      const href = link.getAttribute('href');
      if (rel.includes('stylesheet') && href && !/^https?:/i.test(href)) {
        const cssPath = resolvePath(path, href).path;
        const style = make('style');
        link.replaceWith(style);
        if (this.zip.get(cssPath)) {
          jobs.push(this.zip.text(cssPath).then((t) => this._processCss(t, cssPath)).then((t) => { style.textContent = t; }));
        }
      } else link.remove();
    }
    for (const style of doc.querySelectorAll('style')) {
      if (style.textContent.includes('url(') || style.textContent.includes('@import')) {
        jobs.push(this._processCss(style.textContent, path).then((t) => { style.textContent = t; }));
      }
    }
    for (const el of doc.querySelectorAll('[style*="url("]')) {
      jobs.push(this._processCss(el.getAttribute('style'), path).then((t) => el.setAttribute('style', t)));
    }
    await Promise.all(jobs.map((j) => j.catch(() => {})));

    let head = doc.querySelector('head');
    if (!head) { head = make('head'); doc.documentElement.insertBefore(head, doc.documentElement.firstChild); }
    const style = make('style');
    style.setAttribute('id', 'shiori-style');
    style.textContent = readerCss;
    head.appendChild(style);

    const blob = isXml
      ? new Blob([new XMLSerializer().serializeToString(doc)], { type: 'application/xhtml+xml' })
      : new Blob(['<!DOCTYPE html>' + doc.documentElement.outerHTML], { type: 'text/html' });
    const url = URL.createObjectURL(blob);
    this.chapterUrls.push(url);
    while (this.chapterUrls.length > 3) URL.revokeObjectURL(this.chapterUrls.shift());
    return url;
  }

  /** 解析章内链接，返回 { index, hash }；站外链接返回 null */
  /** 第 index 章的纯文本（和阅读器里数字的方式一致），给全书搜索用 */
  async plainText(index, skip) {
    const source = await this.zip.text(this.spine[index].path);
    let doc = new DOMParser().parseFromString(source, 'application/xhtml+xml');
    if (doc.getElementsByTagName('parsererror').length || !doc.documentElement || doc.documentElement.localName !== 'html') {
      doc = new DOMParser().parseFromString(source, 'text/html');
    }
    for (const el of doc.querySelectorAll('script, iframe, object, embed, base, meta[http-equiv]')) el.remove();
    const body = doc.body || doc.querySelector('body');
    if (!body) return '';
    const walker = doc.createTreeWalker(body, NodeFilter.SHOW_TEXT, {
      acceptNode: (n) => (n.parentElement?.closest(skip) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
    });
    let out = '';
    for (let n = walker.nextNode(); n; n = walker.nextNode()) out += n.data;
    return out;
  }

  resolveLink(fromIndex, href) {
    if (!href || /^[a-z][a-z0-9+.-]*:/i.test(href)) return null;
    const { path, hash } = resolvePath(this.spine[fromIndex].path, href);
    const index = this.spine.findIndex((c) => c.path === path);
    return index < 0 ? null : { index, hash };
  }

  /** 全书进度 0~1 */
  percentAt(index, fraction) {
    let before = 0;
    for (let i = 0; i < index; i++) before += this.spine[i].size;
    return Math.min(1, (before + this.spine[index].size * fraction) / this.totalSize);
  }
  locate(percent) {
    let target = percent * this.totalSize;
    for (let i = 0; i < this.spine.length; i++) {
      if (target < this.spine[i].size || i === this.spine.length - 1) {
        return { index: i, fraction: Math.min(0.9999, target / this.spine[i].size) };
      }
      target -= this.spine[i].size;
    }
    return { index: 0, fraction: 0 };
  }

  async close() {
    for (const p of this.urls.values()) { try { URL.revokeObjectURL(await p); } catch { /* 忽略 */ } }
    for (const u of this.chapterUrls) URL.revokeObjectURL(u);
    this.urls.clear();
  }
}
