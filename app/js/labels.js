// 内置的文库 / 出版社资料：编辑书籍信息时可以检索，书脊会按文库换上对应的小标和排版。
// 标志图片只用于在你自己的书架上区分文库；排版是软件里的示意，不是逐版复刻的真实书脊。
// layout：top = 小标在最上面；gagaga = 小标在上、人物图在作者下面；fantasia = 圆标在书名和作者之间；legacy = 旧版 MF 文库 J
// mark：square = 方形小标（放在白色标签区里），wide = 横版字标，light = 白色字标（直接印在书脊底色上）
export const LABELS = [
  { id: 'mfj', name: 'MF文庫J', company: 'KADOKAWA', logo: 'mfj', mark: 'square', layout: 'top', aka: ['MF文库J', 'MF Bunko J', 'MF文庫', 'MFJ'] },
  { id: 'mfj-old', name: 'MF文庫J（旧版）', short: 'MF文庫J', company: 'メディアファクトリー', logo: 'mfj-old', mark: 'square', layout: 'legacy', aka: ['MF文库J旧版', 'Media Factory', 'メディアファクトリー'] },
  { id: 'fantasia', name: 'ファンタジア文庫', company: 'KADOKAWA', logo: 'fantasia', mark: 'square', layout: 'fantasia', aka: ['富士見ファンタジア文庫', '富士见Fantasia文库', 'Fantasia文库', '富士见文库', 'Fujimi Fantasia'] },
  { id: 'sneaker', name: '角川スニーカー文庫', company: 'KADOKAWA', logo: 'sneaker', mark: 'square', layout: 'top', aka: ['角川Sneaker文库', 'Sneaker文库', 'スニーカー文庫', 'Kadokawa Sneaker'] },
  { id: 'dengeki', name: '電撃文庫', company: 'KADOKAWA', logo: 'dengeki', mark: 'square', layout: 'top', aka: ['电击文库', 'Dengeki Bunko', '電撃'] },
  { id: 'famitsu', name: 'ファミ通文庫', company: 'KADOKAWA', logo: 'famitsu', mark: 'square', layout: 'top', aka: ['法米通文库', 'Famitsu Bunko', 'FB文库'] },
  { id: 'mfbooks', name: 'MFブックス', company: 'KADOKAWA', logo: 'mfbooks', mark: 'square', layout: 'top', aka: ['MF Books'] },
  { id: 'kadokawabooks', name: 'カドカワBOOKS', company: 'KADOKAWA', logo: 'kadokawabooks', mark: 'square', layout: 'top', aka: ['角川BOOKS', 'Kadokawa Books'] },
  { id: 'dengekinew', name: '電撃の新文芸', company: 'KADOKAWA', layout: 'top', aka: ['电击新文艺'] },
  { id: 'dragon', name: 'ドラゴンノベルス', company: 'KADOKAWA', logo: 'dragon', mark: 'square', layout: 'top', aka: ['Dragon Novels'] },
  { id: 'beans', name: '角川ビーンズ文庫', company: 'KADOKAWA', logo: 'beans', mark: 'square', layout: 'top', aka: ['角川Beans文库', 'Beans Bunko'] },
  { id: 'bslog', name: 'ビーズログ文庫', company: 'KADOKAWA', logo: 'bslog', mark: 'square', layout: 'top', aka: ["B's-LOG文库", "B's-LOG Bunko"] },
  { id: 'gagaga', name: 'ガガガ文庫', short: 'ガガガ文庫', company: '小学館', logo: 'gagaga', mark: 'wide', layout: 'gagaga', aka: ['GAGAGA文库', 'GAGAGA', '嘎嘎嘎文库', '小学馆', 'Gagaga Bunko'] },
  { id: 'ga', name: 'GA文庫', company: 'SBクリエイティブ', logo: 'ga', mark: 'wide', layout: 'top', aka: ['GA文库', 'SB Creative', 'SB创意'] },
  { id: 'hj', name: 'HJ文庫', company: 'ホビージャパン', logo: 'hj', mark: 'wide', layout: 'top', aka: ['HJ文库', 'Hobby Japan'] },
  { id: 'hjnovels', name: 'HJノベルス', company: 'ホビージャパン', logo: 'hjnovels', mark: 'wide', layout: 'top', aka: ['HJ Novels'] },
  { id: 'overlap', name: 'オーバーラップ文庫', company: 'オーバーラップ', logo: 'overlap', mark: 'wide', layout: 'top', aka: ['Overlap文库', 'Overlap Bunko'] },
  { id: 'overlapnovels', name: 'オーバーラップノベルス', company: 'オーバーラップ', layout: 'top', aka: ['Overlap Novels'] },
  { id: 'dashx', name: 'ダッシュエックス文庫', company: '集英社', layout: 'top', aka: ['Dash X文库', 'DashX', '集英社'] },
  { id: 'klb', name: '講談社ラノベ文庫', company: '講談社', logo: 'klb', mark: 'square', layout: 'top', aka: ['讲谈社轻小说文库', '讲谈社', 'Kodansha Ranobe'] },
  { id: 'gcn', name: 'GCノベルズ', company: 'マイクロマガジン社', logo: 'gcn', mark: 'light', layout: 'top', aka: ['GC Novels'] },
  { id: 'gcnB', name: 'GCN文庫', company: 'マイクロマガジン社', layout: 'top', aka: ['GCN Bunko'] },
  { id: 'earthstar', name: 'アース・スターノベル', company: 'アース・スター エンターテイメント', logo: 'earthstar', mark: 'wide', layout: 'top', aka: ['Earth Star Novel'] },
  { id: 'earthluna', name: 'アース・スタールナ', company: 'アース・スター エンターテイメント', logo: 'earthluna', mark: 'wide', layout: 'top', aka: ['Earth Star Luna'] },
  { id: 'hero', name: 'ヒーロー文庫', company: 'イマジカインフォス', logo: 'hero', mark: 'wide', layout: 'top', aka: ['Hero文库', 'Hero Bunko'] },
  { id: 'sqex', name: 'SQEXノベル', company: 'スクウェア・エニックス', layout: 'top', aka: ['Square Enix', 'SQEX Novel'] },
  { id: 'dre', name: 'DREノベルス', company: 'ドリコム', layout: 'top', aka: ['DRE Novels'] },
  { id: 'pash', name: 'PASH!ブックス', company: '主婦と生活社', logo: 'pash', mark: 'wide', layout: 'top', aka: ['PASH! Books'] },
  { id: 'monster', name: 'モンスター文庫', company: '双葉社', layout: 'top', aka: ['Monster文库', '双叶社'] },
  { id: 'iris', name: '一迅社文庫アイリス', company: '一迅社', logo: 'iris', mark: 'wide', layout: 'top', aka: ['一迅社文库Iris', '一迅社'] },
  { id: 'arianrose', name: 'アリアンローズ', company: 'フロンティアワークス', layout: 'top', aka: ['Arian Rose'] },
  { id: 'saga', name: 'サーガフォレスト', company: '一二三書房', layout: 'top', aka: ['Saga Forest'] },
  { id: 'brave', name: 'ブレイブ文庫', company: '一二三書房', layout: 'top', aka: ['Brave文库'] },
  { id: 'grast', name: 'グラストNOVELS', company: 'スターツ出版', layout: 'top', aka: ['Grast Novels'] },
  { id: 'berry', name: 'ベリーズファンタジー', company: 'スターツ出版', layout: 'top', aka: ["Berry's Fantasy"] },
  { id: 'kaesuma', name: 'KAエスマ文庫', company: '京都アニメーション', logo: 'kaesuma', mark: 'wide', layout: 'top', aka: ['KA Esuma文库', '京都动画'] },
  // 中文版常见的出版社（没有标志，书脊上只印名字）
  { id: 'tw-kadokawa', name: '台灣角川', company: '台灣角川', layout: 'top', aka: ['台湾角川', '角川'] },
  { id: 'tianwen', name: '天闻角川', company: '天闻角川', layout: 'top', aka: ['天聞角川'] },
  { id: 'chingwin', name: '青文出版', company: '青文出版社', layout: 'top', aka: ['青文', '青文出版社'] },
  { id: 'spp', name: '尖端出版', company: '城邦文化', layout: 'top', aka: ['尖端', '浮文字'] },
  { id: 'tongli', name: '東立出版', company: '東立出版社', layout: 'top', aka: ['东立', '東立', '东立出版社'] },
  { id: 'qingzhi', name: '轻之文库', company: '轻之文库', layout: 'top', aka: ['輕之文庫', '轻文'] },
];

const byId = new Map(LABELS.map((l) => [l.id, l]));
const companyCount = new Map();
for (const l of LABELS) if (l.id !== 'mfj-old') companyCount.set(l.company, (companyCount.get(l.company) || 0) + 1);
export const labelById = (id) => byId.get(id) || null;
export const logoUrl = (l) => (l?.logo ? `img/labels/${l.logo}.png` : '');

// 比较时把简繁、全半角、空格这些差异抹平
const norm = (s) => String(s || '').normalize('NFKC').toLowerCase().replace(/[\s・·._\-!！'’（）()]/g, '')
  .replace(/库/g, '庫').replace(/击/g, '撃').replace(/馆/g, '館').replace(/讲谈/g, '講談').replace(/东立/g, '東立');
const keysOf = (l) => [l.name, l.short, l.company, ...l.aka].filter(Boolean).map(norm);

/** 出版社那一栏里写的字 → 最像的文库（找不到就是 null） */
export function matchLabel(text) {
  const t = norm(text);
  if (!t) return null;
  let best = null, score = 0;
  for (const l of LABELS) {
    for (const k of keysOf(l)) {
      const s = k === t ? 100 : (t.includes(k) && k.length >= 3) ? 60 + k.length : 0;
      // 公司名只在没有更具体的文库名时才算数（KADOKAWA 下面有好多文库）
      const adj = k === norm(l.company) && k !== norm(l.name) && (companyCount.get(l.company) || 0) > 1 ? s - 50 : s;
      if (adj > score) { score = adj; best = l; }
    }
  }
  return score >= 60 ? best : null;
}

/** 输入框检索：按名字、别名、公司名模糊匹配，返回最多 limit 条 */
export function searchLabels(text, extra = [], limit = 8) {
  const t = norm(text);
  const rows = LABELS.map((l) => {
    const ks = keysOf(l);
    let s = 0;
    if (!t) s = 1;
    else for (const k of ks) {
      if (k === t) s = Math.max(s, 100);
      else if (k.startsWith(t)) s = Math.max(s, 80);
      else if (k.includes(t)) s = Math.max(s, 60);
    }
    return { label: l, score: s };
  }).filter((r) => r.score > 0);
  // 书库里已经在用、但不在内置表里的出版社名也一起给出来
  for (const name of extra) {
    if (!name || matchLabel(name)) continue;
    const k = norm(name);
    if (!t || k.includes(t)) rows.push({ label: { id: '', name, company: '书库里用过的名字' }, score: t && k.startsWith(t) ? 79 : 59 });
  }
  return rows.sort((a, b) => b.score - a.score).slice(0, limit).map((r) => r.label);
}

/** 一本书该用哪个文库：自己选过的优先，否则按出版社文字猜 */
export const labelOf = (book) => labelById(book?.imprint) || matchLabel(book?.publisher);
