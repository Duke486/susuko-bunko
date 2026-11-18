// 自动查作品资料：Bangumi + AniList 找候选，名字不标准时用 DeepSeek 搜索确认正确名字，最后让模型（或规则）挑出最像的那一个。
//
// 流程：
//   1. 用书名 / 系列名去 Bangumi（中文资料最全）和 AniList（英文名、罗马音、别名）各搜一次；
//   2. 如果最好的候选和输入对不上（输入是错别字、俗称、梗名），且配置了 DeepSeek 搜索：
//      搜一下网页，让模型从搜索结果里读出作品的正式名字（日文原名 / 中文名 / 英文名），再用这些名字重新搜；
//   3. 合并候选，配置了模型就让模型挑（返回编号和把握），否则按名字相似度挑；
//   4. 不直接改书：把候选和推荐交给客户端，用户确认后再填进去。
// 调用外部接口用的密钥由客户端每次随请求带来（和阅读助手的转发一样），服务器不保存。

const UA = 'susuko-bunko/0.11 (https://github.com/; self-hosted reading app)'; // Bangumi 要求带能识别应用的 User-Agent
const BGM = process.env.BGM_API || 'https://api.bgm.tv';
const ANILIST = process.env.ANILIST_API || 'https://graphql.anilist.co';
const DEEPSEEK = process.env.DEEPSEEK_API || 'https://api.deepseek.com';

const norm = (s) => String(s || '').normalize('NFKC').toLowerCase().replace(/[\s・·.,，。!！?？:：;；'"“”‘’「」『』《》〈〉()（）[\]【】~～\-—_/\\]/g, '');
/** 两个名字有多像（0~1）：一样=1，互相包含按长度比例，否则按二字组重合 */
function similar(a, b) {
  a = norm(a); b = norm(b);
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.includes(b) || b.includes(a)) return 0.6 + 0.35 * (Math.min(a.length, b.length) / Math.max(a.length, b.length));
  const grams = (s) => { const m = new Map(); for (let i = 0; i < s.length - 1; i++) { const g = s.slice(i, i + 2); m.set(g, (m.get(g) || 0) + 1); } return m; };
  const ga = grams(a), gb = grams(b);
  let hit = 0;
  for (const [g, n] of ga) hit += Math.min(n, gb.get(g) || 0);
  return (2 * hit) / Math.max(1, a.length - 1 + b.length - 1) * 0.85;
}
/** 去掉卷号、括号里的版本说明、文件名里常见的杂字 */
function cleanQuery(q) {
  return String(q || '')
    .replace(/\.(epub|cbz|zip|txt|pdf)$/i, '')
    .replace(/[\[【][^\]】]*[\]】]/g, ' ') // 文件名里方括号一般是“轻小说”“汉化组”这类标记
    .replace(/[（(][^）)]*(汉化|扫图|文库|EPUB|epub|完结|全\d+|第?\d+(-\d+)?[卷册话])[^）)]*[）)]/g, ' ')
    .replace(/(第\s*[\d一二三四五六七八九十百]+\s*[卷册部话集]|vol\.?\s*\d+|\s\d{1,3}$)/gi, ' ')
    .replace(/\s+/g, ' ').trim();
}

async function getJson(url, opts = {}, timeout = 15000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeout);
  try {
    const r = await fetch(url, { ...opts, signal: ctrl.signal, headers: { 'User-Agent': UA, Accept: 'application/json', ...(opts.headers || {}) } });
    const text = await r.text();
    let data = null;
    try { data = JSON.parse(text); } catch { /* 不是 JSON */ }
    if (!r.ok) {
      const msg = data?.error?.message || data?.description || data?.message || `${r.status}`;
      throw Object.assign(new Error(String(msg).slice(0, 160)), { status: r.status });
    }
    return data;
  } finally { clearTimeout(t); }
}

// ---------- Bangumi ----------
const infoVal = (box, ...keys) => {
  for (const it of box || []) {
    if (!keys.includes(it.key)) continue;
    const v = Array.isArray(it.value) ? it.value.map((x) => x.v ?? x).filter(Boolean) : [it.value];
    return v.map(String).filter(Boolean);
  }
  return [];
};
function fromBangumi(s) {
  const box = s.infobox || [];
  const aliases = [...infoVal(box, '别名', '中文名'), ...infoVal(box, '英文名')];
  return {
    source: 'bangumi', id: s.id, url: `https://bgm.tv/subject/${s.id}`,
    titleCn: s.name_cn || '', title: s.name || '', aliases: [...new Set(aliases)].filter((x) => x !== s.name && x !== s.name_cn),
    author: infoVal(box, '作者', '原作', '著者')[0] || '',
    illustrator: infoVal(box, '插图', '作画', '插画', '漫画')[0] || '',
    publisher: infoVal(box, '出版社', '连载杂志', '文库')[0] || '',
    label: infoVal(box, '文库', '书系', '连载杂志')[0] || '',
    date: (s.date || infoVal(box, '发售日', '开始', '发行日期')[0] || '').replace(/年|月/g, '-').replace(/日/, '').replace(/-+$/, ''),
    summary: (s.summary || '').trim(),
    tags: (s.tags || []).sort((a, b) => b.count - a.count).map((t) => t.name).filter((t) => t.length <= 12).slice(0, 12),
    cover: s.images?.common || s.images?.medium || s.image || '',
    platform: s.platform || '', series: !!s.series, volumes: s.volumes || 0,
  };
}
async function bangumiSearch(keyword, token) {
  const headers = { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) };
  const data = await getJson(`${BGM}/v0/search/subjects?limit=10`, { method: 'POST', headers, body: JSON.stringify({ keyword, sort: 'match', filter: { type: [1] } }) });
  return (data?.data || []).map(fromBangumi);
}
async function bangumiDetail(id, token) {
  const data = await getJson(`${BGM}/v0/subjects/${id}`, { headers: token ? { Authorization: 'Bearer ' + token } : {} });
  return fromBangumi(data);
}

// ---------- AniList ----------
const ANILIST_QUERY = `query ($s: String, $f: [MediaFormat]) {
  Page(perPage: 6) { media(search: $s, type: MANGA, format_in: $f) {
    id siteUrl format title { romaji english native } synonyms description(asHtml: false)
    startDate { year month day } coverImage { medium } genres tags { name rank }
    staff(perPage: 6) { edges { role node { name { full native } } } }
  } } }`;
function fromAnilist(m) {
  const staff = (role) => m.staff?.edges?.find((e) => role.test(e.role || ''))?.node?.name;
  const person = (n) => (n ? n.native || n.full : '');
  const d = m.startDate || {};
  return {
    source: 'anilist', id: m.id, url: m.siteUrl,
    titleCn: '', title: m.title?.native || m.title?.romaji || '',
    aliases: [...new Set([m.title?.romaji, m.title?.english, ...(m.synonyms || [])].filter(Boolean))],
    author: person(staff(/story|original|author/i)), illustrator: person(staff(/illustrat|art/i)),
    publisher: '', label: '',
    date: d.year ? [d.year, d.month && String(d.month).padStart(2, '0'), d.day && String(d.day).padStart(2, '0')].filter(Boolean).join('-') : '',
    summary: String(m.description || '').replace(/<[^>]+>/g, '').replace(/\(Source:[^)]*\)/i, '').trim(),
    tags: [...(m.genres || []), ...(m.tags || []).filter((t) => t.rank >= 60).map((t) => t.name)].slice(0, 10),
    cover: m.coverImage?.medium || '', platform: m.format === 'NOVEL' ? '小说' : '漫画',
  };
}
async function anilistSearch(s, kind) {
  const f = kind === 'manga' ? ['MANGA', 'ONE_SHOT'] : ['NOVEL'];
  const data = await getJson(ANILIST, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ query: ANILIST_QUERY, variables: { s, f } }) });
  return (data?.data?.Page?.media || []).map(fromAnilist);
}

// ---------- DeepSeek 搜索 ----------
async function deepseekSearch(query, key, question) {
  const data = await getJson(`${DEEPSEEK}/v1/tools/search`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
    body: JSON.stringify({ query: query.slice(0, 128), count: 8, ori_question: question.slice(0, 128) }),
  }, 20000);
  // rerank_score ≥ 1.5 算优质结果；太差的不要，省得把模型带偏
  return (data?.results || []).filter((r) => (r.rerank_score ?? 3) >= 1).slice(0, 6)
    .map((r) => ({ title: r.title, site: r.site_name, text: (r.summary || r.snippet || '').slice(0, 700) }));
}

// ---------- 模型 ----------
async function askModel(ai, system, user) {
  const data = await getJson(ai.url, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...(ai.key ? { Authorization: 'Bearer ' + ai.key } : {}) },
    body: JSON.stringify({ model: ai.model, temperature: 0, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] }),
  }, 40000);
  const text = data?.choices?.[0]?.message?.content || '';
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error('模型没有按格式回答');
  return JSON.parse(m[0]);
}

const kindText = (kind) => (kind === 'manga' ? '漫画' : '轻小说');
const brief = (c, i) => `[${i}] ${c.source}｜${[c.titleCn, c.title, ...c.aliases.slice(0, 4)].filter(Boolean).join(' / ')}｜作者:${c.author || '?'}｜${c.platform || ''}${c.series ? '（系列）' : ''}｜${c.date || ''}`;

/** 主流程。opts: { query, kind, author, bangumiToken, dsKey, ai: { url, key, model } } */
async function lookup(opts) {
  const steps = [];
  const kind = opts.kind === 'manga' ? 'manga' : 'novel';
  const q = cleanQuery(opts.query);
  if (!q) throw Object.assign(new Error('没有可以搜索的名字'), { status: 400 });
  const pool = new Map(); // `${source}:${id}` → 候选
  const add = (list) => { for (const c of list) pool.set(`${c.source}:${c.id}`, c); };
  const score = (c, names) => Math.max(...names.map((n) => Math.max(similar(n, c.titleCn), similar(n, c.title), ...c.aliases.map((a) => similar(n, a)))))
    + (opts.author && c.author && similar(opts.author, c.author) > 0.6 ? 0.15 : 0);
  async function searchAll(name) {
    const [b, a] = await Promise.allSettled([bangumiSearch(name, opts.bangumiToken), anilistSearch(name, kind)]);
    if (b.status === 'fulfilled') add(b.value); else steps.push(`Bangumi 搜索出错：${b.reason.message}`);
    if (a.status === 'fulfilled') add(a.value); else steps.push(`AniList 搜索出错：${a.reason.message}`);
    return [b.status === 'fulfilled' ? b.value.length : 0, a.status === 'fulfilled' ? a.value.length : 0];
  }

  const [nb, na] = await searchAll(q);
  steps.push(`用「${q}」搜索：Bangumi ${nb} 个，AniList ${na} 个`);
  let names = [q];
  let best = Math.max(0, ...[...pool.values()].map((c) => score(c, names)));

  // 名字对不上：上网查一下正式名字（俗称、错别字、梗名都能靠网页搜索纠正过来）
  if (best < 0.75 && opts.dsKey) {
    try {
      const hits = await deepseekSearch(`${q} ${kindText(kind)}`, opts.dsKey, `「${q}」是哪部${kindText(kind)}？正式名字和原名是什么？`);
      steps.push(`名字不够标准，用 DeepSeek 搜索查了 ${hits.length} 条网页`);
      let found = [];
      if (hits.length && opts.ai?.url) {
        const r = await askModel(opts.ai,
          '你从网页搜索结果里找出用户说的是哪部作品。只回答 JSON：{"names":["日文原名","官方中文名","英文名或罗马音"],"confidence":0到1}。找不到就给空数组，不要编造。',
          `用户输入：${q}\n作品类型：${kindText(kind)}\n搜索结果：\n${hits.map((x, i) => `(${i + 1}) ${x.title}｜${x.site}\n${x.text}`).join('\n\n')}`);
        found = (r.names || []).filter((n) => typeof n === 'string' && n.trim()).slice(0, 3);
      } else {
        // 没有模型时，从标题里抓书名号里的名字
        for (const x of hits) for (const m of `${x.title} ${x.text}`.matchAll(/[《「『]([^》」』]{2,40})[》」』]/g)) found.push(m[1]);
        found = [...new Set(found)].slice(0, 3);
      }
      if (found.length) {
        steps.push(`确认的名字：${found.join(' / ')}`);
        for (const n of found) await searchAll(n);
        names = [q, ...found];
        best = Math.max(0, ...[...pool.values()].map((c) => score(c, names)));
      }
    } catch (e) { steps.push(`DeepSeek 搜索没成功：${e.message}`); }
  } else if (best < 0.75) steps.push('名字不够标准；在设置里填上 DeepSeek 搜索的 Key，可以先上网确认正式名字');

  let list = [...pool.values()].map((c) => ({ ...c, match: Math.round(score(c, names) * 100) / 100 }))
    .sort((a, b) => b.match - a.match || (a.source === 'bangumi' ? -1 : 1)).slice(0, 10);
  if (!list.length) return { query: q, names, candidates: [], pick: null, confidence: 0, steps };

  // Bangumi 搜索结果里的资料不全，把排在前面的几个补成完整资料
  await Promise.all(list.filter((c) => c.source === 'bangumi').slice(0, 4).map(async (c) => {
    try { Object.assign(c, { ...(await bangumiDetail(c.id, opts.bangumiToken)), match: c.match }); } catch { /* 用搜索结果里的就行 */ }
  }));

  let pick = 0, confidence = Math.min(1, list[0].match), by = '名字相似度';
  if (opts.ai?.url) {
    try {
      const r = await askModel(opts.ai,
        '你帮用户确认书架上的一本书对应资料库里的哪个条目。优先选“系列”条目而不是单卷；类型必须一致（轻小说≠漫画改编）。只回答 JSON：{"pick":编号或null,"confidence":0到1,"reason":"一句话"}。都不对就 pick=null。',
        `书架上的名字：${q}${opts.author ? `\n作者：${opts.author}` : ''}\n类型：${kindText(kind)}\n${names.length > 1 ? `网上确认的正式名字：${names.slice(1).join(' / ')}\n` : ''}候选：\n${list.map(brief).join('\n')}`);
      if (r.pick === null) { pick = null; confidence = 0; by = `模型认为都不对：${r.reason || ''}`; }
      else if (Number.isInteger(r.pick) && list[r.pick]) { pick = r.pick; confidence = Number(r.confidence) || 0.5; by = `模型判断：${r.reason || ''}`; }
    } catch (e) { steps.push(`模型判断没成功（${e.message}），改按名字相似度挑`); }
  }
  steps.push(pick === null ? by : `推荐第 ${pick + 1} 个（${by}）`);

  // 同一部作品在 AniList 上的英文名、罗马音也并进别名
  if (pick !== null) {
    const p = list[pick];
    for (const c of list) if (c !== p && c.source !== p.source && [c.title, ...c.aliases].some((n) => [p.title, p.titleCn, ...p.aliases].some((m) => similar(n, m) > 0.9))) {
      p.aliases = [...new Set([...p.aliases, c.title, ...c.aliases])].filter((x) => x && x !== p.title && x !== p.titleCn).slice(0, 12);
      if (!p.illustrator && c.illustrator) p.illustrator = c.illustrator;
    }
  }
  return { query: q, names, candidates: list, pick, confidence, steps };
}

module.exports = { lookup, cleanQuery, similar };
