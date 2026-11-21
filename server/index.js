import express from 'express';
import os from 'node:os';
import path from 'node:path';
import { ROOT, loadConfig, saveConfig, publicConfig, resolveSlot, slotFromForm } from './config.js';
import { listModels } from './llm.js';
import { fetchPage } from './fetchPage.js';
import { VENDOR, infoPayload, checkAnalyze, testConnection, analyzeEvents, planEvents } from './core.js';

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '0.0.0.0';

const app = express();
app.use(express.json({ limit: '60mb' }));

app.get('/vendor/:file', (req, res) => {
  const rel = VENDOR[req.params.file];
  if (!rel) return res.status(404).end();
  res.type('application/javascript').sendFile(path.join(ROOT, rel));
});
app.use('/samples', express.static(path.join(ROOT, 'samples')));
app.use(express.static(path.join(ROOT, 'public')));

// ---------- 设置 ----------
app.get('/api/info', (_req, res) => res.json(infoPayload({ lanUrls: lanUrls() })));

app.get('/api/config', (_req, res) => res.json(publicConfig()));

app.post('/api/config', (req, res) => {
  saveConfig(req.body || {});
  res.json(publicConfig());
});

app.post('/api/models', async (req, res) => {
  try {
    const slot = slotFromForm(req.body.kind || 'vision', req.body.form);
    res.json({ models: await listModels(slot) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/test', async (req, res) => {
  const kind = req.body.kind || 'vision';
  const { status, json } = await testConnection(kind, slotFromForm(kind, req.body.form));
  res.status(status).json(json);
});

// ---------- 读取网页链接 ----------
app.post('/api/fetch-url', async (req, res) => {
  try {
    res.json(await fetchPage(req.body.url));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ---------- SSE ----------
/** 把 [事件名, 数据] 生成器写成 SSE；浏览器断开时中止上游请求。 */
async function pipeSse(req, res, makeEvents) {
  const ctrl = new AbortController();
  res.on('close', () => {
    if (!res.writableFinished) ctrl.abort();
  });
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  for await (const [event, data] of makeEvents(ctrl.signal)) {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }
  res.end();
}

// ---------- 照片解析 ----------
app.post('/api/analyze', async (req, res) => {
  const bad = checkAnalyze(req.body);
  if (bad) return res.status(400).json({ error: bad });
  const slot = resolveSlot('vision');
  await pipeSse(req, res, (signal) => analyzeEvents({ body: req.body, slot, gear: loadConfig().gear, signal }));
});

// ---------- 拍摄策划 / 脚本 ----------
app.post('/api/plan', async (req, res) => {
  const slot = resolveSlot('text');
  await pipeSse(req, res, (signal) => planEvents({ body: req.body, slot, gear: loadConfig().gear, signal }));
});

function lanUrls() {
  const urls = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const ni of list || []) {
      // 只要局域网地址；198.18.x.x 这类是代理软件的虚拟网卡，手机连不上
      if (ni.family === 'IPv4' && !ni.internal && /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ni.address)) {
        urls.push(`http://${ni.address}:${PORT}`);
      }
    }
  }
  return urls;
}

loadConfig();
app.listen(PORT, HOST, () => {
  console.log(`\n  机位 · 照片拍法解析 已启动`);
  console.log(`  本机打开： http://localhost:${PORT}`);
  for (const u of lanUrls()) console.log(`  手机打开： ${u}  （手机和电脑连同一个 Wi-Fi）`);
  console.log('');
});
