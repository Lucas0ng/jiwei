// GitHub Pages 版：没有后端，前端发出的 /api/* 请求在浏览器里就地处理。
// 解析、策划由浏览器直接调用模型服务商（千问、DeepSeek、豆包、Gemini、OpenAI、OpenRouter、Grok 都允许跨域直连），
// 设置、Key 和器材只存在当前浏览器的 localStorage 里，不经过任何中间服务器。
// 业务逻辑复用 server/ 里的 core.js / llm.js / settings.js，由 scripts/build-pages.mjs 一起打包。
import { PRESETS, normalizeConfig, mergeConfig, publicConfigOf, resolveSlotOf, slotFromFormOf } from './server/settings.js';
import { infoPayload, checkAnalyze, testConnection, analyzeEvents, planEvents } from './server/core.js';
import { listModels } from './server/llm.js';

const STORE_KEY = 'jiwei-config';

// 实测智谱的接口不返回跨域头，浏览器调不通
PRESETS.zhipu.note = '网页版用不了：智谱的接口不允许浏览器直接调用，请换千问、DeepSeek 或豆包。';

function loadConfig() {
  try {
    return normalizeConfig(JSON.parse(localStorage.getItem(STORE_KEY) || 'null'));
  } catch {
    return normalizeConfig(null);
  }
}

function saveConfig(cfg) {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(cfg));
  } catch {
    throw new Error('浏览器不允许保存设置（可能开了无痕模式或禁用了网站数据）。');
  }
}

/** 浏览器直连失败时，补一句可能的原因。 */
function explain(msg = '') {
  return /连不上/.test(msg) ? `${msg}。网页版由浏览器直连服务商：检查网络，或这家服务商不允许浏览器直接调用（换千问、DeepSeek 试试）。` : msg;
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json; charset=utf-8' } });
}

/** 把 [事件名, 数据] 生成器写成 SSE 响应，和服务端版格式一致；停止时按 AbortError 结束，前端显示「已停止」。 */
function sse(events, signal) {
  const enc = new TextEncoder();
  let ctl;
  let closed = false;
  const stream = new ReadableStream({
    start(c) {
      ctl = c;
      signal?.addEventListener('abort', () => {
        if (closed) return;
        closed = true;
        ctl.error(new DOMException('已停止', 'AbortError'));
      });
    },
    async pull(c) {
      const { value, done } = await events.next();
      if (closed) return;
      if (done) {
        closed = true;
        return c.close();
      }
      const [event, data] = value;
      if (event === 'error' && data?.error) data.error = explain(data.error);
      c.enqueue(enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
    },
    cancel() {
      closed = true;
      events.return?.();
    },
  });
  return new Response(stream, { headers: { 'Content-Type': 'text/event-stream; charset=utf-8' } });
}

async function handle(path, init) {
  const method = (init.method || 'GET').toUpperCase();
  let body = {};
  if (method === 'POST') {
    try {
      body = JSON.parse(init.body || '{}') || {};
    } catch {
      return json({ error: '请求内容不是有效的 JSON。' }, 400);
    }
  }
  const cfg = loadConfig();

  switch (`${method} ${path}`) {
    case 'GET /api/info':
      return json(infoPayload({ pages: true }));
    case 'GET /api/config':
      return json(publicConfigOf(cfg));
    case 'POST /api/config': {
      const next = mergeConfig(cfg, body);
      saveConfig(next);
      return json(publicConfigOf(next));
    }
    case 'POST /api/models':
      try {
        return json({ models: await listModels(slotFromFormOf(cfg, body.kind || 'vision', body.form)) });
      } catch (err) {
        return json({ error: explain(err.message) }, 400);
      }
    case 'POST /api/test': {
      const kind = body.kind || 'vision';
      const { status, json: out } = await testConnection(kind, slotFromFormOf(cfg, kind, body.form));
      if (out.error) out.error = explain(out.error);
      return json(out, status);
    }
    case 'POST /api/fetch-url':
      return json({ error: '网页版读不了链接（浏览器不允许网页抓取别的网站），把图片截图或保存后上传即可。' }, 400);
    case 'POST /api/analyze': {
      const bad = checkAnalyze(body);
      if (bad) return json({ error: bad }, 400);
      return sse(analyzeEvents({ body, slot: resolveSlotOf(cfg, 'vision'), gear: cfg.gear, signal: init.signal }), init.signal);
    }
    case 'POST /api/plan':
      return sse(planEvents({ body, slot: resolveSlotOf(cfg, 'text'), gear: cfg.gear, signal: init.signal }), init.signal);
    default:
      return json({ error: '没有这个接口。' }, 404);
  }
}

// 只接管以 /api/ 开头的相对请求；调用模型服务商、读取图片等其他请求照常发出
const realFetch = window.fetch.bind(window);
window.fetch = (input, init = {}) => {
  const url = typeof input === 'string' ? input : '';
  if (url.startsWith('/api/')) {
    return handle(url, init).catch((err) => json({ error: `出错了：${err.message}` }, 500));
  }
  return realFetch(input, init);
};
