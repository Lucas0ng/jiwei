// OpenAI 兼容的流式调用。通义千问、DeepSeek、智谱、豆包、Gemini、Grok、OpenRouter 都走这一套。

export class LLMError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

function explainHttpError(status, bodyText) {
  let detail = bodyText;
  try {
    const j = JSON.parse(bodyText);
    detail = j.error?.message || j.message || j.error || bodyText;
    if (typeof detail !== 'string') detail = JSON.stringify(detail);
  } catch {
    /* 不是 JSON，用原文 */
  }
  detail = String(detail).slice(0, 400);
  const hints = {
    400: '请求被拒绝：常见原因是这个模型不支持图片输入，或模型名写错了。',
    401: 'API Key 无效或已过期。',
    402: '账户余额不足。',
    403: '没有这个模型的权限，或该地区不可用。',
    404: '接口地址或模型名不存在，检查 Base URL 和模型名。',
    413: '图片太大，试试少传几张。',
    429: '请求太频繁或额度用完了，稍后再试。',
  };
  const hint = hints[status] || (status >= 500 ? '服务商那边出错了，稍后重试。' : '');
  return `${hint}（HTTP ${status}：${detail}）`;
}

/** 关闭思考模式的参数。只对已知支持的服务商发送，别家收到陌生参数可能报错。 */
function noThinkingParams(slot) {
  if (slot.provider === 'qwen') return { enable_thinking: false };
  if (slot.provider === 'zhipu') return { thinking: { type: 'disabled' } };
  return {};
}

/**
 * 流式对话。逐段产出 { type: 'reasoning' | 'text', delta }。
 * slot: { provider, baseURL, apiKey, model }
 * thinking: false 时尽量关闭模型的思考过程（写策划这类任务不需要，能快很多）
 */
export async function* streamChat({ slot, messages, maxTokens = 8192, thinking = true, signal }) {
  if (!slot.baseURL) throw new LLMError('还没有填写 Base URL，请到「设置」里配置模型。', 400);
  if (!slot.apiKey) throw new LLMError('还没有填写 API Key，请到「设置」里配置模型。', 401);
  if (!slot.model) throw new LLMError('还没有填写模型名，请到「设置」里配置模型。', 400);

  const extra = thinking ? {} : noThinkingParams(slot);
  const post = async (withMax, withExtra = true) => {
    try {
      return await fetch(`${slot.baseURL}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${slot.apiKey}`,
        },
        body: JSON.stringify({ model: slot.model, messages, stream: true, ...(withMax ? { max_tokens: maxTokens } : {}), ...(withExtra ? extra : {}) }),
        signal,
      });
    } catch (err) {
      if (err.name === 'AbortError') throw err;
      throw new LLMError(`连不上模型服务（${slot.baseURL}）：${err.cause?.code || err.message}`, 502);
    }
  };

  let res = await post(true);
  if (!res.ok) {
    let body = await res.text().catch(() => '');
    // 有的服务商 max_tokens 上限更低，超了会 400；去掉这个参数用它的默认值再试一次
    if (res.status === 400 && /max_tokens|max_completion_tokens|maximum.*tokens/i.test(body)) {
      res = await post(false);
      if (!res.ok) body = await res.text().catch(() => '');
    }
    // 模型不支持关闭思考时，按默认方式再试一次
    if (!res.ok && res.status === 400 && Object.keys(extra).length && /thinking/i.test(body)) {
      res = await post(true, false);
      if (!res.ok) body = await res.text().catch(() => '');
    }
    if (!res.ok) throw new LLMError(explainHttpError(res.status, body), res.status);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let finishReason = null;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (!data || data === '[DONE]') continue;
      let json;
      try {
        json = JSON.parse(data);
      } catch {
        continue;
      }
      if (json.error) throw new LLMError(json.error.message || JSON.stringify(json.error), 500);
      const choice = json.choices?.[0];
      if (!choice) continue;
      const d = choice.delta || {};
      const reasoning = d.reasoning_content ?? d.reasoning ?? null;
      if (reasoning) yield { type: 'reasoning', delta: reasoning };
      if (d.content) yield { type: 'text', delta: d.content };
      if (choice.finish_reason) finishReason = choice.finish_reason;
    }
  }
  if (finishReason === 'length') yield { type: 'truncated' };
}

/** 一次性拿全文（测试连接用）。 */
export async function chatOnce({ slot, messages, maxTokens = 64, signal }) {
  let text = '';
  for await (const ev of streamChat({ slot, messages, maxTokens, signal })) {
    if (ev.type === 'text') text += ev.delta;
  }
  return text;
}

/** 拉服务商的模型列表（GET /models）。 */
export async function listModels(slot) {
  if (!slot.baseURL) throw new LLMError('先填写 Base URL。', 400);
  if (!slot.apiKey) throw new LLMError('先填写 API Key。', 401);
  const res = await fetch(`${slot.baseURL}/models`, {
    headers: { Authorization: `Bearer ${slot.apiKey}` },
    signal: AbortSignal.timeout(15000),
  }).catch((err) => {
    throw new LLMError(`连不上 ${slot.baseURL}：${err.cause?.code || err.message}`, 502);
  });
  if (!res.ok) throw new LLMError(explainHttpError(res.status, await res.text().catch(() => '')), res.status);
  const json = await res.json();
  const list = json.data || json.models || [];
  return list
    .map((m) => (typeof m === 'string' ? m : m.id || m.name || ''))
    .map((id) => id.replace(/^models\//, ''))
    .filter(Boolean)
    .sort();
}
