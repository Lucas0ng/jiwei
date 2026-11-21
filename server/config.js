// 本地运行时的设置存储：保存在项目根目录的 config.local.json。
// 设置的合并、打码等逻辑在 settings.js，Cloudflare Worker 也用同一份。
import fs from 'node:fs';
import path from 'node:path';
import { normalizeConfig, applyEnvKeys, mergeConfig, publicConfigOf, resolveSlotOf, slotFromFormOf } from './settings.js';

export { PRESETS, hasGear } from './settings.js';

export const ROOT = path.resolve(import.meta.dirname, '..');
const CONFIG_FILE = path.join(ROOT, 'config.local.json');

let stored = null;

function loadStored() {
  if (stored) return stored;
  let saved = {};
  try {
    saved = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch {
    saved = {};
  }
  stored = normalizeConfig(saved);
  return stored;
}

/** 实际使用的配置：环境变量里的 Key 覆盖文件里的，方便部署时不把 Key 写进文件。 */
export function loadConfig() {
  return applyEnvKeys(loadStored(), process.env);
}

export function saveConfig(input = {}) {
  const next = mergeConfig(loadStored(), input);
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(next, null, 2), { mode: 0o600 });
  stored = next;
  return loadConfig();
}

export const publicConfig = () => publicConfigOf(loadConfig());
export const resolveSlot = (kind) => resolveSlotOf(loadConfig(), kind);
export const slotFromForm = (kind, form) => slotFromFormOf(loadConfig(), kind, form);
