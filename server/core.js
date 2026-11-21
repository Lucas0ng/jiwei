// 解析、策划、测试连接的业务逻辑。只用 fetch 和纯 JS，本地 Express 和 Cloudflare Worker 共用。
// 流式接口写成异步生成器，逐个产出 [事件名, 数据]，由各自的运行环境写成 SSE。
import { jsonrepair } from 'jsonrepair';
import { streamChat, chatOnce, LLMError } from './llm.js';
import { analyzeSystemPrompt, analyzeUserContent, planSystemPrompt, planUserPrompt, PLAN_MODES, gearText } from './prompts.js';
import { SAMPLE_ANALYSIS, SAMPLE_PLAN, mockStream } from './mock.js';
import { PRESETS, hasGear } from './settings.js';

// 前端依赖直接从 node_modules 提供，不走 CDN，离线也能用
export const VENDOR = {
  'exifr.js': 'node_modules/exifr/dist/full.esm.mjs',
  'marked.js': 'node_modules/marked/lib/marked.esm.js',
  'purify.js': 'node_modules/dompurify/dist/purify.es.mjs',
};

// 64×64 纯红 PNG，测试连接时确认视觉模型真的接受图片输入
const TEST_IMAGE =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAeUlEQVR4nO3PQQkAMAzAwCqpf1ETMxF7HINABFzm7H7dcEEDWtCAFjSgBQ1oQQNa0IAWNKAFDWhBA1rQgBY0oAUNaEEDWtCAFjSgBQ1oQQNa0IAWNKAFDWhBA1rQgBY0oAUNaEEDWtCAFjSgBQ1oQQNa0IAWNKAFj13PLIEAOXyUUwAAAABJRU5ErkJggg==';

export function infoPayload(extra = {}) {
  return {
    presets: PRESETS,
    planModes: Object.fromEntries(Object.entries(PLAN_MODES).map(([k, v]) => [k, v.label])),
    lanUrls: [],
    ...extra,
  };
}

export function parseModelJson(text) {
  let s = text.trim();
  s = s.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '');
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start >= 0 && end > start) s = s.slice(start, end + 1);
  else if (start >= 0) s = s.slice(start);
  try {
    return JSON.parse(s);
  } catch {
    return JSON.parse(jsonrepair(s));
  }
}

/** 解析请求的参数检查，不通过时返回错误文案。 */
export function checkAnalyze(body) {
  const images = body?.images || [];
  if (!images.length) return '请先上传至少一张照片。';
  if (images.length > 6) return '一次最多 6 张。';
  return null;
}

/** 测试连接，返回 { status, json }。 */
export async function testConnection(kind, slot) {
  if (slot.provider === 'mock') return { status: 200, json: { ok: true, reply: '演示模式不需要连接。' } };
  try {
    const started = Date.now();
    const content =
      kind === 'vision'
        ? [
            { type: 'text', text: '这张图是什么颜色？只回答颜色。' },
            { type: 'image_url', image_url: { url: TEST_IMAGE } },
          ]
        : '回复“连接成功”四个字。';
    const reply = await chatOnce({ slot, messages: [{ role: 'user', content }], maxTokens: 512, signal: AbortSignal.timeout(60000) });
    return { status: 200, json: { ok: true, reply: reply.trim().slice(0, 200) || '（模型返回为空）', ms: Date.now() - started } };
  } catch (err) {
    return { status: 400, json: { ok: false, error: err.message } };
  }
}

/** 照片解析。gear 是设置里保存的器材。 */
export async function* analyzeEvents({ body, slot, gear, signal }) {
  const { images = [], exif = [], note = '', source = null, deep = false } = body || {};
  const isMock = slot.provider === 'mock';
  yield ['status', { text: isMock ? '演示模式：返回示例结果' : `正在用 ${slot.model} ${deep ? '深度' : ''}分析 ${images.length} 张照片…`, mock: isMock }];

  let full = '';
  try {
    const stream = isMock
      ? mockStream(JSON.stringify(SAMPLE_ANALYSIS, null, 2), { chunk: 40, delay: 12 })
      : streamChat({
          slot,
          signal,
          maxTokens: 16384, // 思考型模型的推理也算在内，给足空间避免 JSON 被截断
          thinking: Boolean(deep), // 默认关闭思考：千问上约 25 秒出结果，打开约 45 秒
          messages: [
            { role: 'system', content: analyzeSystemPrompt() },
            { role: 'user', content: analyzeUserContent({ images, exif, note, source, gear: hasGear(gear) ? gear : null }) },
          ],
        });
    for await (const ev of stream) {
      if (ev.type === 'text') full += ev.delta;
      if (ev.type === 'truncated') yield ['status', { text: '输出被截断，结果可能不完整。' }];
      else yield [ev.type, { delta: ev.delta }];
    }
    let analysis = null;
    try {
      analysis = parseModelJson(full);
    } catch {
      yield ['error', { error: '模型没有按格式返回结果，下面是原始输出。可以重试，或在设置里换一个模型。', raw: full }];
      return;
    }
    yield ['done', { analysis, mock: isMock, model: slot.model }];
  } catch (err) {
    if (err.name !== 'AbortError') yield ['error', { error: err instanceof LLMError ? err.message : `出错了：${err.message}`, raw: full }];
  }
}

/** 拍摄策划 / 脚本。策划页没填器材时，用设置里保存的器材。 */
export async function* planEvents({ body, slot, gear: savedGear, signal }) {
  const { mode = 'plan', brief = '', gear = '', extra = '', analysis = null } = body || {};
  const isMock = slot.provider === 'mock';
  yield ['status', { text: isMock ? '演示模式：返回示例策划' : `正在用 ${slot.model} 写${PLAN_MODES[mode]?.label || '方案'}…`, mock: isMock }];
  try {
    const stream = isMock
      ? mockStream(SAMPLE_PLAN, { chunk: 12, delay: 14 })
      : streamChat({
          slot,
          signal,
          maxTokens: 16384,
          thinking: false, // 写策划不需要长时间推理，关掉后首字从约 2 分钟降到几秒
          messages: [
            { role: 'system', content: planSystemPrompt() },
            { role: 'user', content: planUserPrompt({ mode, brief, gear: gear || gearText(savedGear), extra, analysis }) },
          ],
        });
    for await (const ev of stream) {
      if (ev.type === 'truncated') yield ['status', { text: '输出被截断，方案可能不完整。' }];
      else yield [ev.type, { delta: ev.delta }];
    }
    yield ['done', { mock: isMock, model: slot.model }];
  } catch (err) {
    if (err.name !== 'AbortError') yield ['error', { error: err instanceof LLMError ? err.message : `出错了：${err.message}` }];
  }
}
