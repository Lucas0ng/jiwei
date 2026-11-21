// 设置的纯逻辑：服务商预设、合并保存、打码回显、取用某个用途的连接。
// 不碰文件系统，本地 Express（存 config.local.json）和 Cloudflare Worker（存 KV）共用。

// 所有服务商都走 OpenAI 兼容的 /chat/completions 接口。
// models 只是建议值，模型名更新很快，设置页可以「获取模型列表」直接拉服务商的最新列表。
export const PRESETS = {
  mock: {
    label: '演示模式（无需 Key）',
    baseURL: '',
    vision: ['demo'],
    text: ['demo'],
    keyUrl: '',
    note: '返回内置示例结果，用来看界面效果，不会真的分析你的图片。',
  },
  qwen: {
    label: '通义千问 · 阿里云百炼（推荐）',
    baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    vision: ['qwen3.8-flash', 'qwen3.7-plus', 'qwen3.8-max', 'qwen3-vl-plus'],
    text: ['qwen3.8-flash', 'qwen3.7-plus', 'qwen3.8-max'],
    keyUrl: 'https://bailian.console.aliyun.com/?tab=model#/api-key',
    note: '国内直连，看图能力强，价格低。',
  },
  deepseek: {
    label: 'DeepSeek',
    baseURL: 'https://api.deepseek.com',
    vision: ['deepseek-flash'],
    text: ['deepseek-flash', 'deepseek-chat', 'deepseek-reasoner'],
    keyUrl: 'https://platform.deepseek.com/api_keys',
    note: 'deepseek-flash 支持图片输入；写策划、脚本性价比很高。',
  },
  zhipu: {
    label: '智谱 GLM',
    baseURL: 'https://open.bigmodel.cn/api/paas/v4',
    vision: ['glm-4.6v', 'glm-4.6v-flash'],
    text: ['glm-4.6', 'glm-4.6v'],
    keyUrl: 'https://bigmodel.cn/usercenter/proj-mgmt/apikeys',
    note: 'glm-4.6v-flash 免费，可用来试用。',
  },
  doubao: {
    label: '豆包 · 火山方舟',
    baseURL: 'https://ark.cn-beijing.volces.com/api/v3',
    vision: [],
    text: [],
    keyUrl: 'https://console.volcengine.com/ark/region:ark+cn-beijing/apiKey',
    note: '模型名请在方舟控制台复制（Doubao-Seed 2.0 系列支持看图）。',
  },
  gemini: {
    label: 'Google Gemini',
    baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai',
    vision: ['gemini-3.8-flash'],
    text: ['gemini-3.8-flash'],
    keyUrl: 'https://aistudio.google.com/apikey',
    note: '需要能访问 Google 的网络。',
  },
  xai: {
    label: 'xAI Grok',
    baseURL: 'https://api.x.ai/v1',
    vision: [],
    text: [],
    keyUrl: 'https://console.x.ai',
    note: '点「获取模型列表」选择支持图片的 Grok 模型。',
  },
  openai: {
    label: 'OpenAI',
    baseURL: 'https://api.openai.com/v1',
    vision: [],
    text: [],
    keyUrl: 'https://platform.openai.com/api-keys',
    note: '点「获取模型列表」选择模型。',
  },
  openrouter: {
    label: 'OpenRouter（一个 Key 用各家模型）',
    baseURL: 'https://openrouter.ai/api/v1',
    vision: [],
    text: [],
    keyUrl: 'https://openrouter.ai/keys',
    note: '模型名形如 google/gemini-xxx、qwen/qwen3-vl-xxx。',
  },
  custom: {
    label: '自定义（任意 OpenAI 兼容接口）',
    baseURL: '',
    vision: [],
    text: [],
    keyUrl: '',
    note: '填 Base URL（到 /v1 为止）、Key 和模型名。',
  },
};

const DEFAULT_CONFIG = {
  vision: { provider: 'mock', baseURL: '', apiKey: '', model: 'demo' },
  text: { sameAsVision: true, provider: 'mock', baseURL: '', apiKey: '', model: 'demo' },
  // 用户自己的器材，用来给出「用你的器材怎么拍」
  gear: { camera: '', lenses: [], phone: '', others: '' },
};

/** 把存储里读出来的配置补齐默认值。saved 是 config.local.json 或 KV 里的原始内容。 */
export function normalizeConfig(saved = {}) {
  saved = saved || {};
  return {
    vision: { ...DEFAULT_CONFIG.vision, ...(saved.vision || {}) },
    text: { ...DEFAULT_CONFIG.text, ...(saved.text || {}) },
    gear: cleanGear(saved.gear),
  };
}

/** 环境变量 / Worker Secret 里的 Key 覆盖存储里的 Key（只影响使用，不写回存储）。 */
export function applyEnvKeys(cfg, env = {}) {
  const out = { vision: { ...cfg.vision }, text: { ...cfg.text }, gear: cfg.gear };
  if (env.JIWEI_VISION_API_KEY) out.vision.apiKey = env.JIWEI_VISION_API_KEY;
  if (env.JIWEI_TEXT_API_KEY) out.text.apiKey = env.JIWEI_TEXT_API_KEY;
  return out;
}

export function maskKey(key) {
  if (!key) return '';
  if (key.length <= 8) return '••••';
  return `${key.slice(0, 3)}••••${key.slice(-4)}`;
}

// 前端回显的是打码 Key（含 •），这种值永远不当成新 Key
const isMasked = (key) => key.includes('•');

function cleanSlot(input = {}, prev = {}) {
  const provider = PRESETS[input.provider] ? input.provider : prev.provider || 'mock';
  const preset = PRESETS[provider];
  let apiKey = prev.apiKey || '';
  // 前端拿到的是打码后的 Key；只有用户真的输入了新 Key 才覆盖
  if (typeof input.apiKey === 'string' && input.apiKey && !isMasked(input.apiKey)) {
    apiKey = input.apiKey.trim();
  }
  if (input.clearKey) apiKey = '';
  return {
    provider,
    baseURL: String(input.baseURL ?? preset.baseURL ?? '').trim().replace(/\/+$/, ''),
    apiKey,
    model: String(input.model ?? '').trim(),
  };
}

function cleanGear(g = {}) {
  g = g || {};
  const str = (v, n) => String(v ?? '').trim().slice(0, n);
  const lenses = (Array.isArray(g.lenses) ? g.lenses : String(g.lenses ?? '').split('\n'))
    .map((x) => str(x, 80))
    .filter(Boolean)
    .slice(0, 20);
  return { camera: str(g.camera, 100), lenses, phone: str(g.phone, 60), others: str(g.others, 200) };
}

export function hasGear(g) {
  return Boolean(g && (g.camera || g.lenses?.length || g.phone));
}

/** 只更新传进来的部分（vision / text / gear），没传的保持原样。prev 是存储里的原始配置。 */
export function mergeConfig(prev, input = {}) {
  input = input || {};
  return {
    vision: input.vision ? cleanSlot(input.vision, prev.vision) : prev.vision,
    text: input.text ? { sameAsVision: input.text.sameAsVision !== false, ...cleanSlot(input.text, prev.text) } : prev.text,
    gear: input.gear ? cleanGear(input.gear) : prev.gear,
  };
}

/** 给前端看的配置：Key 打码。 */
export function publicConfigOf(cfg) {
  const pub = (slot) => ({ ...slot, apiKey: maskKey(slot.apiKey), hasKey: Boolean(slot.apiKey) });
  return { vision: pub(cfg.vision), text: pub(cfg.text), gear: cfg.gear };
}

/** 取出某个用途要用的连接配置。text 勾选「同视觉模型」时直接复用 vision。 */
export function resolveSlotOf(cfg, kind) {
  if (kind === 'text' && cfg.text.sameAsVision) return { ...cfg.vision };
  const slot = { ...cfg[kind] };
  // 文字模型和视觉模型是同一家且没单独填 Key 时，复用视觉模型的 Key
  if (kind === 'text' && !slot.apiKey && slot.provider === cfg.vision.provider) slot.apiKey = cfg.vision.apiKey;
  return slot;
}

/** 设置页「测试连接/获取模型」时，用表单里尚未保存的值，Key 为打码值时回落到已保存的 Key。 */
export function slotFromFormOf(cfg, kind, form = {}) {
  form = form || {};
  const saved = cfg[kind] || {};
  const preset = PRESETS[form.provider] || PRESETS[saved.provider] || PRESETS.custom;
  let apiKey = form.apiKey || '';
  // 只有服务商没变时才回落到已保存的 Key，避免把 A 家的 Key 发给 B 家
  if (!apiKey || isMasked(apiKey)) apiKey = form.provider === saved.provider ? saved.apiKey || '' : '';
  return {
    provider: form.provider || saved.provider,
    baseURL: String(form.baseURL || preset.baseURL || '').trim().replace(/\/+$/, ''),
    apiKey,
    model: String(form.model || '').trim(),
  };
}
