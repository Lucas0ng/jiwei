// 打包 GitHub Pages 版到 site/：纯静态，没有后端。
// public/ + samples/ + 前端依赖，外加浏览器端的接口层（pages/）和它要用的 server/ 纯逻辑模块。
// 本地预览：node scripts/build-pages.mjs && npx serve site（或任意静态服务器）
import fs from 'node:fs';
import path from 'node:path';
import { VENDOR } from '../server/core.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const OUT = path.join(ROOT, 'site');
// 浏览器端用得到的服务端模块（不含 Express、文件读写、网页抓取）
const SERVER_MODULES = ['core.js', 'llm.js', 'prompts.js', 'mock.js', 'settings.js'];

fs.rmSync(OUT, { recursive: true, force: true });
fs.cpSync(path.join(ROOT, 'public'), OUT, { recursive: true });
fs.cpSync(path.join(ROOT, 'samples'), path.join(OUT, 'samples'), { recursive: true });
fs.cpSync(path.join(ROOT, 'pages'), OUT, { recursive: true });

fs.mkdirSync(path.join(OUT, 'vendor'));
for (const [name, rel] of Object.entries(VENDOR)) {
  fs.copyFileSync(path.join(ROOT, rel), path.join(OUT, 'vendor', name));
}
fs.cpSync(path.join(ROOT, 'node_modules/jsonrepair/lib/esm'), path.join(OUT, 'vendor/jsonrepair'), {
  recursive: true,
  filter: (src) => !src.endsWith('.map'),
});

fs.mkdirSync(path.join(OUT, 'server'));
for (const file of SERVER_MODULES) {
  let code = fs.readFileSync(path.join(ROOT, 'server', file), 'utf8');
  code = code.replace(/from 'jsonrepair'/g, "from '../vendor/jsonrepair/index.js'");
  if (/from '(?!\.)/.test(code.replace(/from '\.\.\/vendor\//g, ''))) throw new Error(`server/${file} 引用了浏览器里没有的包`);
  fs.writeFileSync(path.join(OUT, 'server', file), code);
}

// 入口换成 boot.js：先装接口层再跑 app.js
const indexPath = path.join(OUT, 'index.html');
const html = fs.readFileSync(indexPath, 'utf8');
if (!html.includes('src="app.js"')) throw new Error('index.html 里没找到 app.js 入口');
fs.writeFileSync(indexPath, html.replace('src="app.js"', 'src="boot.js"'));
// 关掉 Jekyll，按原样发布所有文件
fs.writeFileSync(path.join(OUT, '.nojekyll'), '');

console.log(`site/ 已生成（${fs.readdirSync(OUT, { recursive: true }).length} 个文件）`);
