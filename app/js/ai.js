// 阅读助手（查词 / 翻译 / 提问）与听书。助手接的是 OpenAI 兼容的接口（OpenAI、DeepSeek、通义、Kimi、本地 Ollama 等都行）。
import { prefs, account } from './store.js';

export const DEFAULT_PROMPT = `你是一位耐心的轻小说阅读助手，读者正在阅读日本轻小说（可能是日文原版，也可能是中文译本）。
回答要简洁、准确，优先结合读者给出的上下文来解释；不确定时直接说明，不要编造。
不要剧透读者还没读到的情节。`;

export const LANGUAGES = ['简体中文', '繁體中文', '日本語', 'English', '한국어'];

const DEFAULT_AI = {
  base: 'https://api.openai.com/v1', key: '', model: 'gpt-4o-mini',
  prompt: DEFAULT_PROMPT, target: '简体中文', viaServer: true,
};
export const aiSettings = () => ({ ...DEFAULT_AI, ...prefs.get('ai', {}) });
export const saveAiSettings = (patch) => prefs.set('ai', { ...aiSettings(), ...patch });
export const aiReady = () => !!aiSettings().base && !!aiSettings().model;

/** 往用户配置的接口发 POST。登录了服务器且勾选“经服务器转发”时走服务器，避开浏览器跨域限制。 */
async function post(path, payload, signal) {
  const ai = aiSettings();
  const url = ai.base.replace(/\/+$/, '') + path;
  const acct = account();
  let res;
  try {
    if (acct && ai.viaServer) {
      res = await fetch(acct.url + '/api/ai', {
        method: 'POST', signal,
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + acct.token },
        body: JSON.stringify({ url, key: ai.key, payload }),
      });
    } else {
      res = await fetch(url, {
        method: 'POST', signal,
        headers: { 'Content-Type': 'application/json', ...(ai.key ? { Authorization: 'Bearer ' + ai.key } : {}) },
        body: JSON.stringify(payload),
      });
    }
  } catch (e) {
    if (e.name === 'AbortError') throw e;
    throw new Error(acct && ai.viaServer ? '连不上服务器' : '连不上接口。如果地址没错，可能是接口不允许浏览器直接访问，可以登录服务器后打开“经服务器转发”');
  }
  if (!res.ok) {
    let message = `接口返回 ${res.status}`;
    try { const j = await res.json(); message = j.error?.message || j.error || j.message || message; } catch { /* 不是 JSON */ }
    if (res.status === 401) message += '（请检查 API Key）';
    throw new Error(typeof message === 'string' ? message : JSON.stringify(message));
  }
  return res;
}

/** 对话，边生成边回调 onDelta(全文)。返回最终文本。 */
export async function chat(messages, { onDelta, signal } = {}) {
  const ai = aiSettings();
  const res = await post('/chat/completions', {
    model: ai.model, stream: true, temperature: 0.3,
    messages: [{ role: 'system', content: ai.prompt || DEFAULT_PROMPT }, ...messages],
  }, signal);
  const type = res.headers.get('content-type') || '';
  if (!type.includes('event-stream')) { // 不支持流式的接口：一次性返回
    const j = await res.json();
    const text = j.choices?.[0]?.message?.content || '';
    onDelta?.(text);
    return text;
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '', text = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop();
    for (const line of lines) {
      const m = /^data:\s*(.*)$/.exec(line.trim());
      if (!m || m[1] === '[DONE]') continue;
      try {
        const delta = JSON.parse(m[1]).choices?.[0]?.delta?.content;
        if (delta) { text += delta; onDelta?.(text); }
      } catch { /* 半截数据，等下一块 */ }
    }
  }
  return text;
}

export function lookupMessages(word, context, book) {
  const target = aiSettings().target;
  return [{
    role: 'user',
    content: `我在读《${book}》，想查“${word}”这个词。\n所在的句子：${context}\n\n请用${target}回答，按这个格式，简短即可：\n【读音】（日文请给出假名和罗马音；中文给出拼音）\n【词性】\n【释义】\n【在这句里】结合上下文说明它的意思或语气\n【例句】一个简单例句及翻译`,
  }];
}
export function translateMessages(text) {
  const target = aiSettings().target;
  return [{ role: 'user', content: `把下面的文字翻译成${target}。保留原文的语气和人物说话风格，只输出译文：\n\n${text}` }];
}
export function askMessages(question, text, book) {
  return [{ role: 'user', content: `我在读《${book}》，选中了这段文字：\n「${text}」\n\n我的问题：${question}` }];
}

// ---------- 听书 ----------
const DEFAULT_TTS = { engine: 'system', voice: '', rate: 1, apiModel: 'tts-1', apiVoice: 'alloy' };
export const ttsSettings = () => ({ ...DEFAULT_TTS, ...prefs.get('tts', {}) });
export const saveTtsSettings = (patch) => prefs.set('tts', { ...ttsSettings(), ...patch });

const native = () => window.SusukoNative;
const hasNativeTts = () => { try { return !!native()?.ttsAvailable?.(); } catch { return false; } };
const hasWebTts = () => 'speechSynthesis' in window;

/** 系统里能用的声音（网页 / Windows 客户端）。安卓客户端用系统默认的语音引擎。 */
export function systemVoices() {
  if (!hasWebTts()) return Promise.resolve([]);
  const list = speechSynthesis.getVoices();
  if (list.length) return Promise.resolve(list);
  return new Promise((resolve) => {
    const done = () => resolve(speechSynthesis.getVoices());
    speechSynthesis.addEventListener('voiceschanged', done, { once: true });
    setTimeout(done, 1200);
  });
}
export const ttsAvailable = () => ttsSettings().engine === 'api' ? aiReady() : hasWebTts() || hasNativeTts();

const langOf = (text) => (/[぀-ヿ]/.test(text) ? 'ja-JP' : /[一-鿿]/.test(text) ? 'zh-CN' : 'en-US');

// 安卓原生朗读完成后会调用 window.__ttsDone(id)
const nativeWaiters = new Map();
window.__ttsDone = (id, ok = true) => { const w = nativeWaiters.get(String(id)); if (w) { nativeWaiters.delete(String(id)); w(ok); } };

let audio = null;
const apiCache = new Map(); // 预先合成下一句，减少句子之间的停顿
async function apiSpeech(text) {
  if (apiCache.has(text)) return apiCache.get(text);
  const t = ttsSettings();
  const job = post('/audio/speech', { model: t.apiModel, voice: t.apiVoice, input: text, speed: t.rate })
    .then((r) => r.blob()).then((b) => URL.createObjectURL(b));
  apiCache.set(text, job);
  job.catch(() => apiCache.delete(text));
  while (apiCache.size > 4) { const [k, v] = apiCache.entries().next().value; apiCache.delete(k); v.then(URL.revokeObjectURL, () => {}); }
  return job;
}

/** 朗读一句，读完 resolve(true)，被打断 resolve(false) */
export async function speak(text) {
  const t = ttsSettings();
  if (t.engine === 'api') {
    const url = await apiSpeech(text);
    return new Promise((resolve) => {
      audio = new Audio(url);
      audio.onended = () => resolve(true);
      audio.onerror = () => resolve(false);
      audio.onpause = () => { if (!audio?.ended) resolve(false); };
      audio.play().catch(() => resolve(false));
    });
  }
  if (!hasWebTts() && hasNativeTts()) {
    const id = String(Date.now() + Math.random());
    return new Promise((resolve) => {
      nativeWaiters.set(id, resolve);
      try { native().speak(id, text, t.rate, langOf(text)); } catch { nativeWaiters.delete(id); resolve(false); }
    });
  }
  if (!hasWebTts()) throw new Error('这台设备不支持朗读');
  const voices = await systemVoices();
  return new Promise((resolve) => {
    const u = new SpeechSynthesisUtterance(text);
    const lang = langOf(text);
    u.voice = voices.find((v) => v.voiceURI === t.voice) || voices.find((v) => v.lang.replace('_', '-').startsWith(lang.slice(0, 2))) || null;
    u.lang = u.voice?.lang || lang;
    u.rate = t.rate;
    u.onend = () => resolve(true);
    u.onerror = () => resolve(false);
    speechSynthesis.speak(u);
  });
}
export function prefetch(text) { if (ttsSettings().engine === 'api' && text) apiSpeech(text).catch(() => {}); }
export function stopSpeaking() {
  if (hasWebTts()) speechSynthesis.cancel();
  try { native()?.stopSpeaking?.(); } catch { /* 网页版没有原生层 */ }
  for (const [id, w] of nativeWaiters) { nativeWaiters.delete(id); w(false); }
  if (audio) { const a = audio; audio = null; a.pause(); }
}
