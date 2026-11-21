// Cloudflare Worker 入口：和本地 server/index.js 提供同一套 /api 接口。
// 区别：设置存在 KV（JIWEI_KV）里；整个站点要先输入访问密码（Secret: JIWEI_PASSWORD）；
// 静态文件由 Workers Static Assets 提供（scripts/build-cf.mjs 打包到 dist/）。
import { normalizeConfig, applyEnvKeys, mergeConfig, publicConfigOf, resolveSlotOf, slotFromFormOf } from '../server/settings.js';
import { infoPayload, checkAnalyze, testConnection, analyzeEvents, planEvents } from '../server/core.js';
import { listModels } from '../server/llm.js';
import { fetchPage } from '../server/fetchPage.js';

const CONFIG_KEY = 'config';
const COOKIE = 'jiwei_session';
const SESSION_DAYS = 180;
// 不用登录也能访问：登录页本身，以及「添加到主屏幕」要读的图标和清单
const PUBLIC_PATHS = new Set(['/login', '/icon.svg', '/manifest.webmanifest']);

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/login') return handleLogin(request, env);
    if (url.pathname === '/logout') return redirect('/login', clearCookie());
    if (!PUBLIC_PATHS.has(url.pathname)) {
      const denied = await requireSession(request, env, url);
      if (denied) return denied;
    }
    if (url.pathname.startsWith('/api/')) {
      try {
        return await handleApi(request, env, url);
      } catch (err) {
        return json({ error: `出错了：${err.message}` }, 500);
      }
    }
    return env.ASSETS.fetch(request);
  },
};

// ---------- 接口 ----------
async function handleApi(request, env, url) {
  const route = `${request.method} ${url.pathname}`;
  let body = {};
  if (request.method === 'POST') {
    try {
      body = (await request.json()) || {};
    } catch {
      return json({ error: '请求内容不是有效的 JSON。' }, 400);
    }
  }
  const stored = normalizeConfig(await env.JIWEI_KV.get(CONFIG_KEY, 'json'));
  const cfg = applyEnvKeys(stored, env);

  switch (route) {
    case 'GET /api/info':
      return json(infoPayload({ cloud: true }));
    case 'GET /api/config':
      return json(publicConfigOf(cfg));
    case 'POST /api/config': {
      const next = mergeConfig(stored, body);
      await env.JIWEI_KV.put(CONFIG_KEY, JSON.stringify(next));
      return json(publicConfigOf(applyEnvKeys(next, env)));
    }
    case 'POST /api/models':
      try {
        return json({ models: await listModels(slotFromFormOf(cfg, body.kind || 'vision', body.form)) });
      } catch (err) {
        return json({ error: err.message }, 400);
      }
    case 'POST /api/test': {
      const kind = body.kind || 'vision';
      const { status, json: out } = await testConnection(kind, slotFromFormOf(cfg, kind, body.form));
      return json(out, status);
    }
    case 'POST /api/fetch-url':
      try {
        return json(await fetchPage(body.url));
      } catch (err) {
        return json({ error: err.message }, 400);
      }
    case 'POST /api/analyze': {
      const bad = checkAnalyze(body);
      if (bad) return json({ error: bad }, 400);
      const slot = resolveSlotOf(cfg, 'vision');
      return sseResponse((signal) => analyzeEvents({ body, slot, gear: cfg.gear, signal }));
    }
    case 'POST /api/plan': {
      const slot = resolveSlotOf(cfg, 'text');
      return sseResponse((signal) => planEvents({ body, slot, gear: cfg.gear, signal }));
    }
    default:
      return json({ error: '没有这个接口。' }, 404);
  }
}

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers },
  });
}

/**
 * 把 [事件名, 数据] 生成器写成 SSE。
 * 连续的文字片段攒约 80ms 再发一次，Worker 的 CPU 时间和浏览器重绘都少很多，看起来仍是逐字出现。
 * 浏览器断开时写入会失败，这时中止上游模型请求。
 */
function sseResponse(makeEvents) {
  const ctrl = new AbortController();
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const enc = new TextEncoder();
  const write = (event, data) => writer.write(enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));

  (async () => {
    let pendingType = null;
    let pending = '';
    let lastFlush = 0;
    const flush = async () => {
      if (pendingType) {
        const event = pendingType;
        const delta = pending;
        pendingType = null;
        pending = '';
        await write(event, { delta });
      }
      lastFlush = Date.now();
    };
    try {
      for await (const [event, data] of makeEvents(ctrl.signal)) {
        if ((event === 'text' || event === 'reasoning') && typeof data?.delta === 'string') {
          if (pendingType && pendingType !== event) await flush();
          pendingType = event;
          pending += data.delta;
          if (Date.now() - lastFlush >= 80) await flush();
        } else {
          await flush();
          await write(event, data);
        }
      }
      await flush();
    } catch {
      ctrl.abort();
    } finally {
      writer.close().catch(() => {});
    }
  })();

  return new Response(readable, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'X-Accel-Buffering': 'no',
    },
  });
}

// ---------- 访问密码 ----------
/** 会话令牌 = HMAC(密码, 固定串)。改密码后旧令牌自动失效。 */
async function sessionToken(password) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode('jiwei-session-v1'));
  return btoa(String.fromCharCode(...new Uint8Array(sig))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function safeEqual(a, b) {
  const x = new TextEncoder().encode(a);
  const y = new TextEncoder().encode(b);
  if (x.byteLength !== y.byteLength) return false;
  return crypto.subtle.timingSafeEqual(x, y);
}

function readCookie(request, name) {
  const header = request.headers.get('Cookie') || '';
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return v.join('=');
  }
  return '';
}

/** 没登录时：接口返回 401，页面跳到登录页。返回 null 表示放行。 */
async function requireSession(request, env, url) {
  if (!env.JIWEI_PASSWORD) {
    const msg = '还没有设置访问密码。在项目目录运行 npx wrangler secret put JIWEI_PASSWORD 后再打开。';
    return url.pathname.startsWith('/api/') ? json({ error: msg }, 503) : page('还没有设置访问密码', `<p>${msg}</p>`, 503);
  }
  const got = readCookie(request, COOKIE);
  if (got && safeEqual(got, await sessionToken(env.JIWEI_PASSWORD))) return null;
  if (url.pathname.startsWith('/api/')) return json({ error: '需要重新输入访问密码，请刷新页面。' }, 401);
  return redirect('/login');
}

async function handleLogin(request, env) {
  if (!env.JIWEI_PASSWORD) return requireSession(request, env, new URL(request.url));
  if (request.method === 'POST') {
    const form = await request.formData().catch(() => null);
    const input = String(form?.get('password') || '');
    if (input && safeEqual(input, env.JIWEI_PASSWORD)) {
      const token = await sessionToken(env.JIWEI_PASSWORD);
      return redirect('/', `${COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}`);
    }
    return loginPage('密码不对，再试一次。', 401);
  }
  return loginPage();
}

function clearCookie() {
  return `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

function redirect(location, setCookie) {
  const headers = { Location: location, 'Cache-Control': 'no-store' };
  if (setCookie) headers['Set-Cookie'] = setCookie;
  return new Response(null, { status: 303, headers });
}

function loginPage(error = '', status = 200) {
  return page(
    '输入访问密码',
    `<form method="post" action="/login">
      <label for="pw">访问密码</label>
      <input id="pw" name="password" type="password" autocomplete="current-password" autofocus required />
      ${error ? `<p class="err">${error}</p>` : ''}
      <button type="submit">进入</button>
    </form>
    <p class="hint">同一台设备登录一次即可，保持 ${SESSION_DAYS} 天。</p>`,
    status,
  );
}

function page(title, inner, status = 200) {
  const html = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<title>${title} · 机位</title>
<link rel="icon" href="/icon.svg" type="image/svg+xml" />
<link rel="apple-touch-icon" href="/icon.svg" />
<link rel="manifest" href="/manifest.webmanifest" />
<meta name="apple-mobile-web-app-capable" content="yes" />
<meta name="apple-mobile-web-app-title" content="机位" />
<style>
  :root { --bg:#f5f3ef; --card:#fff; --ink:#1d1b18; --muted:#6e685f; --line:#e7e2d9; --accent:#e0532a; --accent-ink:#fff; --danger:#c43d3d; color-scheme: light; }
  @media (prefers-color-scheme: dark) { :root { --bg:#131211; --card:#1c1b19; --ink:#f1ede6; --muted:#a8a197; --line:#2f2c29; --accent:#ff6b3d; --accent-ink:#1a0d07; --danger:#ff7a7a; color-scheme: dark; } }
  * { box-sizing: border-box; }
  body { margin:0; min-height:100vh; display:grid; place-items:center; padding:24px 16px; background:var(--bg); color:var(--ink);
    font: 16px/1.5 -apple-system, BlinkMacSystemFont, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif; }
  main { width:100%; max-width:360px; background:var(--card); border:1px solid var(--line); border-radius:18px; padding:28px 24px; }
  h1 { margin:0 0 4px; font-size:22px; }
  .sub { margin:0 0 22px; color:var(--muted); font-size:14px; }
  label { display:block; font-size:14px; color:var(--muted); margin-bottom:6px; }
  input { width:100%; font:inherit; padding:12px 14px; border-radius:12px; border:1px solid var(--line); background:transparent; color:inherit; }
  input:focus { outline:2px solid var(--accent); outline-offset:1px; }
  button { margin-top:16px; width:100%; font:inherit; font-weight:600; padding:12px; border:0; border-radius:12px; background:var(--accent); color:var(--accent-ink); cursor:pointer; }
  .err { color:var(--danger); font-size:14px; margin:10px 0 0; }
  .hint { color:var(--muted); font-size:13px; margin:16px 0 0; }
</style>
</head>
<body>
<main>
  <h1>机位</h1>
  <p class="sub">照片拍法解析</p>
  ${inner}
</main>
</body>
</html>`;
  return new Response(html, { status, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });
}
