// 把 Cloudflare 要托管的静态文件打包到 dist/：public/ + samples/ + 前端依赖（vendor/）。
// wrangler dev / wrangler deploy 会自动先跑这个脚本（见 wrangler.jsonc 的 build.command）。
import fs from 'node:fs';
import path from 'node:path';
import { VENDOR } from '../server/core.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const OUT = path.join(ROOT, 'dist');

fs.rmSync(OUT, { recursive: true, force: true });
fs.cpSync(path.join(ROOT, 'public'), OUT, { recursive: true });
fs.cpSync(path.join(ROOT, 'samples'), path.join(OUT, 'samples'), { recursive: true });
fs.mkdirSync(path.join(OUT, 'vendor'));
for (const [name, rel] of Object.entries(VENDOR)) {
  fs.copyFileSync(path.join(ROOT, rel), path.join(OUT, 'vendor', name));
}
console.log(`dist/ 已生成（${fs.readdirSync(OUT, { recursive: true }).length} 个文件）`);
