import exifr from './vendor/exifr.js';
import { marked } from './vendor/marked.js';
import DOMPurify from './vendor/purify.js';
import { topView, sideView, LIGHT_TEXT, FACING_TEXT } from './diagram.js';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const arr = (v) => (Array.isArray(v) ? v.filter((x) => x !== null && x !== undefined && x !== '') : v ? [v] : []);

marked.setOptions({ gfm: true, breaks: true });

const MAX_IMAGES = 6;
const MAX_EDGE = 1600; // 送给模型的长边像素
const store = {
  get(key, fallback) {
    try {
      const v = localStorage.getItem(key);
      return v ? JSON.parse(v) : fallback;
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
      return true;
    } catch {
      return false;
    }
  },
};

const state = {
  images: [], // { id, dataUrl, exif, name }
  source: null, // 从链接读取时的网页信息
  analysis: null, // 当前展示的解析
  analysisCtx: null,
  info: null,
  config: null,
  planMode: 'plan',
  planText: '',
  ctrl: null,
  planCtrl: null,
};

// ================= 通用 =================
function toast(msg, ms = 2200) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toast.t);
  toast.t = setTimeout(() => el.classList.remove('show'), ms);
}

async function api(path, body) {
  const res = await fetch(path, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || `请求失败（HTTP ${res.status}）`);
  return json;
}

/** POST 一个 SSE 接口，按事件名回调。 */
async function ssePost(path, body, handlers, signal) {
  const res = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal });
  if (!res.ok || !(res.headers.get('content-type') || '').includes('text/event-stream')) {
    const j = await res.json().catch(() => ({}));
    throw new Error(j.error || `请求失败（HTTP ${res.status}）`);
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const block = buf.slice(0, i);
      buf = buf.slice(i + 2);
      let ev = 'message';
      let data = '';
      for (const line of block.split('\n')) {
        if (line.startsWith('event:')) ev = line.slice(6).trim();
        else if (line.startsWith('data:')) data += line.slice(5).trim();
      }
      if (!data) continue;
      try {
        handlers[ev]?.(JSON.parse(data));
      } catch (e) {
        console.error(e);
      }
    }
  }
}

// ================= 路由 =================
const VIEWS = ['analyze', 'plan', 'history', 'settings'];
function route() {
  const v = VIEWS.includes(location.hash.slice(1)) ? location.hash.slice(1) : 'analyze';
  VIEWS.forEach((name) => ($(`#view-${name}`).hidden = name !== v));
  $$('#tabs a').forEach((a) => a.classList.toggle('active', a.dataset.view === v));
  if (v === 'history') renderHistory();
  if (v === 'plan') syncPlanRef();
  window.scrollTo({ top: 0 });
}
window.addEventListener('hashchange', route);

// ================= 图片处理 =================
const EXIF_PICK = [
  'Make', 'Model', 'LensModel', 'FocalLength', 'FocalLengthIn35mmFormat', 'FNumber', 'ExposureTime', 'ISO',
  'ExposureCompensation', 'ExposureProgram', 'MeteringMode', 'WhiteBalance', 'Flash', 'DateTimeOriginal',
];

async function readExif(blob) {
  try {
    const e = await exifr.parse(blob, { pick: EXIF_PICK, translateValues: true, reviveValues: true });
    if (!e || !(e.FNumber || e.ExposureTime || e.ISO || e.FocalLength)) return null;
    if (e.DateTimeOriginal instanceof Date) e.DateTimeOriginal = e.DateTimeOriginal.toLocaleString('zh-CN');
    for (const k of Object.keys(e)) if (typeof e[k] === 'string') e[k] = e[k].trim();
    return e;
  } catch {
    return null;
  }
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('这张图片浏览器解码不了（可能是 HEIC，换成 JPG 再试）。'));
    img.src = src;
  });
}

async function compress(blob, maxEdge = MAX_EDGE, quality = 0.86) {
  const url = URL.createObjectURL(blob);
  try {
    const img = await loadImage(url);
    const scale = Math.min(1, maxEdge / Math.max(img.naturalWidth, img.naturalHeight));
    const w = Math.round(img.naturalWidth * scale);
    const h = Math.round(img.naturalHeight * scale);
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    canvas.getContext('2d').drawImage(img, 0, 0, w, h);
    return canvas.toDataURL('image/jpeg', quality);
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function thumbOf(dataUrl) {
  const blob = await (await fetch(dataUrl)).blob();
  return compress(blob, 420, 0.72);
}

async function addBlobs(blobs, { fromSource = false } = {}) {
  if (!fromSource && state.source) state.source = null; // 手动加图后不再关联网页
  const room = MAX_IMAGES - state.images.length;
  if (room <= 0) return toast(`最多 ${MAX_IMAGES} 张`);
  const list = blobs.filter((b) => b && (b.type || '').startsWith('image/')).slice(0, room);
  if (blobs.length > room) toast(`最多 ${MAX_IMAGES} 张，多出的已忽略`);
  for (const blob of list) {
    try {
      const [exif, dataUrl] = await Promise.all([readExif(blob), compress(blob)]);
      state.images.push({ id: crypto.randomUUID?.() || String(Math.random()), dataUrl, exif, name: blob.name || '' });
      renderThumbs();
    } catch (err) {
      toast(err.message, 3500);
    }
  }
}

function renderThumbs() {
  const box = $('#thumbs');
  box.innerHTML = state.images
    .map(
      (im, i) => `<div class="thumb">
        <img src="${im.dataUrl}" alt="照片 ${i + 1}">
        <span class="idx">${i + 1}</span>
        ${im.exif ? '<span class="badge exif">EXIF</span>' : ''}
        <button class="x" data-id="${im.id}" aria-label="移除">×</button>
      </div>`,
    )
    .join('');
  if (state.images.length && state.images.length < MAX_IMAGES) box.insertAdjacentHTML('beforeend', '<button class="thumb add" id="addMore" aria-label="再加一张">+</button>');
  $('#drop').classList.toggle('has-images', state.images.length > 0);
  $('#analyzeBtn').disabled = state.images.length === 0;
}

$('#thumbs').addEventListener('click', (e) => {
  const x = e.target.closest('.x');
  if (x) {
    state.images = state.images.filter((im) => im.id !== x.dataset.id);
    if (!state.images.length) state.source = null;
    renderThumbs();
  }
  if (e.target.closest('#addMore')) $('#fileInput').click();
});

$('#pickBtn').onclick = () => $('#fileInput').click();
$('#cameraBtn').onclick = () => $('#cameraInput').click();
$('#fileInput').onchange = (e) => addBlobs([...e.target.files]).finally(() => (e.target.value = ''));
$('#cameraInput').onchange = (e) => addBlobs([...e.target.files]).finally(() => (e.target.value = ''));
$('#sampleBtn').onclick = async () => {
  const blob = await (await fetch('samples/ducks.jpg')).blob();
  $('#noteInput').value = '手机随手拍的，想知道前景树叶怎么虚得这么自然';
  await addBlobs([new File([blob], 'ducks.jpg', { type: 'image/jpeg' })]);
};

const drop = $('#drop');
['dragenter', 'dragover'].forEach((t) => drop.addEventListener(t, (e) => (e.preventDefault(), drop.classList.add('dragging'))));
['dragleave', 'drop'].forEach((t) => drop.addEventListener(t, (e) => (e.preventDefault(), drop.classList.remove('dragging'))));
drop.addEventListener('drop', (e) => addBlobs([...(e.dataTransfer?.files || [])]));

document.addEventListener('paste', (e) => {
  if ($('#view-analyze').hidden) return;
  const files = [...(e.clipboardData?.files || [])].filter((f) => f.type.startsWith('image/'));
  if (files.length) {
    e.preventDefault();
    addBlobs(files);
    return;
  }
  const text = e.clipboardData?.getData('text') || '';
  const inField = ['INPUT', 'TEXTAREA'].includes(document.activeElement?.tagName);
  if (!inField && !state.info?.pages && /https?:\/\//.test(text)) {
    e.preventDefault();
    $('#urlInput').value = text.trim();
    fetchUrl();
  }
});

// ================= 读取链接 =================
async function fetchUrl() {
  const raw = $('#urlInput').value.trim();
  const msg = $('#urlMsg');
  if (!raw) return $('#urlInput').focus();
  const btn = $('#fetchBtn');
  btn.disabled = true;
  btn.textContent = '读取中…';
  msg.className = 'hint';
  msg.textContent = '正在打开网页、提取图片…';
  try {
    const page = await api('/api/fetch-url', { url: raw });
    state.images = [];
    const blobs = await Promise.all(page.images.map(async (im) => (await fetch(im.dataUrl)).blob()));
    await addBlobs(blobs, { fromSource: true });
    state.source = { url: page.url, title: page.title, text: page.text };
    if (page.warnings?.length) {
      msg.className = 'hint err';
      msg.textContent = page.warnings.join(' ');
    } else {
      msg.className = 'hint ok';
      msg.textContent = `读到 ${state.images.length} 张图${page.title ? `：${page.title.slice(0, 40)}` : ''}。网页里的文字也会一起交给 AI 参考。`;
    }
  } catch (err) {
    msg.className = 'hint err';
    msg.textContent = err.message;
  } finally {
    btn.disabled = false;
    btn.textContent = '读取';
  }
}
$('#fetchBtn').onclick = fetchUrl;
$('#urlInput').addEventListener('keydown', (e) => e.key === 'Enter' && fetchUrl());

// ================= 解析 =================
$('#analyzeBtn').onclick = analyze;
$('#deepInput').checked = store.get('jiwei.deep', false);
$('#deepInput').onchange = (e) => store.set('jiwei.deep', e.target.checked);
$('#stopBtn').onclick = () => state.ctrl?.abort();

function livePreviewFrom(text) {
  const pick = (k) => {
    const m = text.match(new RegExp(`"${k}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)`));
    return m ? m[1].replace(/\\n/g, ' ').replace(/\\"/g, '"') : '';
  };
  const title = pick('title');
  const summary = pick('summary');
  return title ? `<h4>${esc(title)}</h4>${summary ? `<p>${esc(summary)}</p>` : ''}` : '';
}

async function analyze() {
  if (!state.images.length) return;
  const live = $('#live');
  const pre = $('#liveText');
  const preview = $('#livePreview');
  const meta = $('#liveMeta');
  live.hidden = false;
  live.className = 'card live';
  pre.innerHTML = '';
  preview.innerHTML = '';
  $('#result').innerHTML = '';
  $('#liveStatus').textContent = '正在上传照片…';
  $('#stopBtn').hidden = false;
  $('#analyzeBtn').disabled = true;
  live.scrollIntoView({ behavior: 'smooth', block: 'start' });

  const images = state.images.map((im) => im.dataUrl);
  const exif = state.images.map((im) => im.exif || null);
  const ctx = { images, exif, mock: false, model: '' };
  let text = '';
  let reasoningLen = 0;
  let reasoningNode = null;
  const t0 = Date.now();
  const tick = setInterval(() => {
    meta.textContent = `${((Date.now() - t0) / 1000).toFixed(0)} 秒 · ${text.length} 字`;
  }, 300);

  state.ctrl = new AbortController();
  try {
    await ssePost(
      '/api/analyze',
      { images, exif, note: $('#noteInput').value.trim(), source: state.source, deep: $('#deepInput').checked },
      {
        status: (d) => {
          $('#liveStatus').textContent = d.text;
          if (d.mock) ctx.mock = true;
        },
        reasoning: (d) => {
          reasoningLen += d.delta.length;
          if (!reasoningNode) {
            reasoningNode = document.createElement('span');
            reasoningNode.className = 'r';
            pre.appendChild(reasoningNode);
          }
          reasoningNode.textContent += d.delta;
          $('#liveStatus').textContent = ctx.mock ? '演示模式：返回示例结果' : `AI 正在观察和推理…（已思考 ${reasoningLen} 字）`;
          pre.scrollTop = pre.scrollHeight;
        },
        text: (d) => {
          if (reasoningNode) {
            pre.appendChild(document.createTextNode('\n\n'));
            reasoningNode = null;
          }
          text += d.delta;
          pre.appendChild(document.createTextNode(d.delta));
          pre.scrollTop = pre.scrollHeight;
          if (!ctx.mock) $('#liveStatus').textContent = 'AI 正在写解析结果…';
          preview.innerHTML = livePreviewFrom(text);
        },
        done: (d) => {
          ctx.mock = d.mock;
          ctx.model = d.model;
          live.classList.add('done');
          $('#liveStatus').textContent = `解析完成 · ${((Date.now() - t0) / 1000).toFixed(1)} 秒${d.mock ? '（演示结果）' : ` · ${d.model}`}`;
          preview.innerHTML = '';
          $('#liveDetails').open = false;
          showAnalysis(d.analysis, ctx);
          saveHistory(d.analysis, ctx);
        },
        error: (d) => {
          live.classList.add('failed');
          $('#liveStatus').textContent = '解析失败';
          $('#result').innerHTML = `<div class="card error-box"><h3>出了点问题</h3><p>${esc(d.error)}</p>${d.raw ? `<details><summary>模型原始输出</summary><pre>${esc(d.raw)}</pre></details>` : ''}</div>`;
        },
      },
      state.ctrl.signal,
    );
  } catch (err) {
    live.classList.add('failed');
    if (err.name === 'AbortError') {
      $('#liveStatus').textContent = '已停止';
    } else {
      $('#liveStatus').textContent = '解析失败';
      $('#result').innerHTML = `<div class="card error-box"><h3>出了点问题</h3><p>${esc(err.message)}</p></div>`;
    }
  } finally {
    clearInterval(tick);
    $('#stopBtn').hidden = true;
    $('#analyzeBtn').disabled = state.images.length === 0;
    state.ctrl = null;
  }
}

// ---------- 结果渲染 ----------
const ICONS = {
  camera: '<svg class="h-icon" viewBox="0 0 24 24"><rect x="3" y="7" width="18" height="13" rx="3"/><circle cx="12" cy="13.5" r="3.5"/><path d="M9 7l1.5-3h3L15 7"/></svg>',
  top: '<svg class="h-icon" viewBox="0 0 24 24"><circle cx="12" cy="6" r="2.5"/><path d="M12 20V10M6 20l6-10 6 10"/></svg>',
  side: '<svg class="h-icon" viewBox="0 0 24 24"><path d="M3 20h18"/><rect x="4" y="11" width="6" height="4" rx="1"/><path d="M10 13l10-5M10 13l10 3"/></svg>',
  exposure: '<svg class="h-icon" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 3v9l6 6M3.5 9h17"/></svg>',
  light: '<svg class="h-icon" viewBox="0 0 24 24"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M5 5l1.5 1.5M17.5 17.5L19 19M5 19l1.5-1.5M17.5 6.5L19 5"/></svg>',
  frame: '<svg class="h-icon" viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M9 5v14M15 5v14M3 10h18M3 14h18"/></svg>',
  scene: '<svg class="h-icon" viewBox="0 0 24 24"><path d="M3 19l6-8 4 5 3-3 5 6z"/><circle cx="16" cy="7" r="2"/></svg>',
  steps: '<svg class="h-icon" viewBox="0 0 24 24"><path d="M5 6h14M5 12h14M5 18h9"/></svg>',
  pose: '<svg class="h-icon" viewBox="0 0 24 24"><circle cx="12" cy="4.5" r="2"/><path d="M5 9l7 1 7-1M12 10v5l-3 6M12 15l3 6"/></svg>',
  warn: '<svg class="h-icon" viewBox="0 0 24 24"><path d="M12 3l9 17H3z"/><path d="M12 10v4M12 17v.5"/></svg>',
  post: '<svg class="h-icon" viewBox="0 0 24 24"><path d="M4 7h10M18 7h2M4 17h4M12 17h8"/><circle cx="16" cy="7" r="2"/><circle cx="10" cy="17" r="2"/></svg>',
  more: '<svg class="h-icon" viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>',
  phone: '<svg class="h-icon" viewBox="0 0 24 24"><rect x="7" y="2" width="10" height="20" rx="2"/><path d="M11 18h2"/></svg>',
};

function fmtShutter(t) {
  if (!t) return '';
  return t >= 1 ? `${t}s` : `1/${Math.round(1 / t)}s`;
}

/** 光圈保留一位小数：iPhone 的 EXIF 记的是 2.798828125 这种有理数换算值。 */
function fmtF(n) {
  return `f/${Number(Number(n).toFixed(1))}`;
}

/** 参数条：有 EXIF 用 EXIF，没有就用模型给的值。 */
function paramValues(a, exif) {
  const e = exif || null;
  const ex = a.exposure || {};
  if (e && (e.FNumber || e.ExposureTime || e.ISO)) {
    return {
      source: 'exif',
      gear: [e.Make, e.Model].filter(Boolean).join(' ').replace(/^(\w+)\s+\1/i, '$1') || a.gear?.camera || '',
      focal: e.FocalLength ? `${Math.round(e.FocalLength)}mm` : a.gear?.focal_length_text?.match(/\d+\s*mm/i)?.[0] || '',
      aperture: e.FNumber ? fmtF(e.FNumber) : ex.aperture?.value,
      shutter: fmtShutter(e.ExposureTime) || ex.shutter?.value,
      iso: e.ISO ? `ISO ${e.ISO}` : ex.iso?.value && `ISO ${String(ex.iso.value).replace(/^iso\s*/i, '')}`,
    };
  }
  return {
    source: ex.source || 'estimated',
    gear: a.gear?.camera?.replace(/[（(].*?[)）]/g, '').trim() || '',
    focal: a.gear?.focal_length_text?.match(/\d+(\.\d+)?\s*mm/i)?.[0] || (a.gear?.focal_length_equiv ? `${a.gear.focal_length_equiv}mm 等效` : ''),
    aperture: ex.aperture?.value,
    shutter: ex.shutter?.value,
    iso: ex.iso?.value && `ISO ${String(ex.iso.value).replace(/^iso\s*/i, '')}`,
  };
}

const SOURCE_BADGE = {
  exif: ['exif', 'EXIF 实测'],
  caption: ['caption', '图片标注'],
  estimated: ['estimated', 'AI 推断'],
};
const CONF_TEXT = { high: '把握大', medium: '把握中等', low: '把握小' };

function sec(icon, title, body, cls = '') {
  return `<div class="card ${cls}"><h3>${ICONS[icon] || ''}${esc(title)}</h3>${body}</div>`;
}

function listHtml(items, cls = 'plain') {
  // 模型有时会自带「1.」「-」之类的序号，页面已经有编号了，去掉免得重复
  const xs = arr(items).map((x) => String(x).replace(/^\s*(?:\d+\s*[.、)）:：]|[-•·*])\s*/, ''));
  if (!xs.length) return '';
  return cls === 'steps' ? `<ol class="steps">${xs.map((x) => `<li><span>${esc(x)}</span></li>`).join('')}</ol>` : `<ul class="${cls}">${xs.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>`;
}

function showAnalysis(a, ctx) {
  state.analysis = a;
  state.analysisCtx = ctx;
  $('#result').innerHTML = renderAnalysis(a, ctx);
  $('#toPlanBtn')?.addEventListener('click', () => {
    $('#briefInput').value = `复刻这组照片的拍法：${a.title || ''}`;
    $('#useAnalysis').checked = true;
    location.hash = '#plan';
  });
  $('#copyAnalysisBtn')?.addEventListener('click', async () => {
    await navigator.clipboard.writeText(analysisToMarkdown(a, ctx)).then(
      () => toast('已复制为文字'),
      () => toast('复制失败，浏览器不允许'),
    );
  });
  $('#reAnalyzeBtn')?.addEventListener('click', () => {
    location.hash = '#analyze';
    if (state.images.length) analyze();
    else window.scrollTo({ top: 0, behavior: 'smooth' });
  });
  syncPlanRef();
}

function renderAnalysis(a, ctx) {
  const ex = a.exposure || {};
  const exif0 = ctx.exif?.[0] || null;
  const pv = paramValues(a, exif0);
  const [bcls, btxt] = ctx.mock ? ['mock', '演示示例'] : SOURCE_BADGE[pv.source] || SOURCE_BADGE.estimated;
  const vals = [pv.focal, pv.aperture, pv.shutter, pv.iso].filter(Boolean);
  const pos = a.position || {};
  const subj = a.subject || {};
  const light = a.light || {};
  const comp = a.composition || {};
  const gear = a.gear || {};
  const post = a.post || {};

  const hero = `<div class="card hero">
    ${ctx.images?.[0] ? `<div class="hero-img"><img src="${ctx.images[0]}" alt="原图"></div>` : ''}
    <div class="hero-body">
      <div class="tags">${arr(a.style_tags).map((t) => `<span class="tag">${esc(t)}</span>`).join('')}</div>
      <h2>${esc(a.title || '拍法解析')}</h2>
      <p class="summary">${esc(a.summary)}</p>
    </div>
    <div class="paramline">
      ${pv.gear ? `<span class="pl-gear">${esc(pv.gear)}</span><span class="pl-sep"></span>` : ''}
      <span class="pl-vals">${vals.map((v) => `<span>${esc(v)}</span>`).join('') || '<span>—</span>'}</span>
      <span class="badge ${bcls}">${btxt}</span>
    </div>
    ${a.key_relation ? `<div class="keyrel"><span>关键关系</span>${esc(a.key_relation)}</div>` : '<div style="height:18px"></div>'}
  </div>`;

  const legend = `<div class="legend"><span><i style="background:var(--accent)"></i>相机视角</span><span><i style="background:var(--ink)"></i>主体${subj.facing && FACING_TEXT[subj.facing] ? '（箭头为朝向）' : ''}</span>${light.direction && LIGHT_TEXT[light.direction] ? '<span><i style="background:var(--sun)"></i>光源方向</span>' : ''}</div>`;
  const diagrams = `<div class="grid two">
    ${sec('top', '俯视站位', `${topView(a)}${legend}<p class="caption">${esc(pos.summary)}</p>`, 'diagram-card')}
    ${sec('side', '侧面机位', `${sideView(a)}<p class="caption">${esc(pos.height_label || '')}${pos.how_to ? `${pos.height_label ? '。' : ''}${esc(pos.how_to)}` : ''}</p>`, 'diagram-card')}
  </div>`;

  const exRows = [
    ['光圈', ex.aperture, exif0?.FNumber && fmtF(exif0.FNumber)],
    ['快门', ex.shutter, exif0?.ExposureTime && fmtShutter(exif0.ExposureTime)],
    ['ISO', ex.iso, exif0?.ISO && String(exif0.ISO)],
    ['曝光补偿', ex.ev, exif0?.ExposureCompensation !== undefined && exif0?.ExposureCompensation !== null && `${exif0.ExposureCompensation} EV`],
    ['白平衡', ex.white_balance, null],
    ['对焦', ex.focus, null],
    ['测光', ex.metering, exif0?.MeteringMode],
  ]
    .filter(([, v, e]) => (v && (v.value || v.why)) || e)
    .map(([k, v = {}, e]) => {
      const value = e || v.value || '—';
      const range = !e && v.range ? `<span class="rng">${esc(v.range)}</span>` : '';
      const why = e ? `EXIF 实测${v.why ? `。${v.why}` : ''}` : v.why;
      return `<tr><th>${k}</th><td class="v">${esc(value)}${range}</td><td class="why">${esc(why || '')}</td></tr>`;
    })
    .join('');
  const confBadge = ex.confidence && !ctx.mock ? `<span class="badge conf">${CONF_TEXT[ex.confidence] || esc(ex.confidence)}</span>` : '';
  const exposure = sec(
    'exposure',
    '曝光参数',
    `<table class="exp-table">${exRows}</table>${ex.mode ? `<p class="exp-mode"><b>建议模式：</b>${esc(ex.mode)} ${confBadge}</p>` : ''}`,
  );

  const exifGear = exif0 ? [[exif0.Make, exif0.Model].filter(Boolean).join(' '), exif0.LensModel].filter(Boolean).join(' · ') : '';
  const gearCard = sec(
    'camera',
    '器材与焦段',
    `<dl class="kv">
      ${exifGear ? `<dt>EXIF</dt><dd>${esc(exifGear)}</dd>` : ''}
      ${gear.camera ? `<dt>机身</dt><dd>${esc(gear.camera)}</dd>` : ''}
      ${gear.lens ? `<dt>镜头</dt><dd>${esc(gear.lens)}</dd>` : ''}
      ${gear.focal_length_text ? `<dt>焦段</dt><dd>${esc(gear.focal_length_text)}</dd>` : ''}
    </dl>
    ${gear.phone ? `<div class="callout"><b>用手机拍</b>${esc(gear.phone)}</div>` : ''}`,
  );

  const lightCard = sec(
    'light',
    '光线',
    `<div class="chips">${[light.type, light.direction_text || LIGHT_TEXT[light.direction], light.time_of_day].filter(Boolean).map((x) => `<span class="chip">${esc(x)}</span>`).join('')}</div>
    ${light.quality ? `<p><b>光质：</b>${esc(light.quality)}</p>` : ''}
    ${light.description ? `<p class="muted">${esc(light.description)}</p>` : ''}`,
  );

  const compCard = sec(
    'frame',
    '构图',
    `<div class="chips">${[comp.aspect, ...arr(comp.rules)].filter(Boolean).map((x) => `<span class="chip">${esc(x)}</span>`).join('')}</div>
    ${comp.horizon ? `<p><b>水平线：</b>${esc(comp.horizon)}</p>` : ''}
    ${subj.size_in_frame ? `<p><b>主体大小：</b>${esc(subj.size_in_frame)}</p>` : ''}
    ${comp.description ? `<p class="muted">${esc(comp.description)}</p>` : ''}`,
  );

  const sceneCard = sec(
    'scene',
    '场景与主体',
    `${a.scene?.location ? `<p>${esc(a.scene.location)}</p>` : ''}
    ${arr(a.scene?.elements).length ? `<div class="chips">${arr(a.scene.elements).map((x) => `<span class="chip">${esc(x)}</span>`).join('')}</div>` : ''}
    ${subj.description ? `<p><b>主体：</b>${esc(subj.description)}</p>` : ''}
    ${subj.pose ? `<p><b>动作：</b>${esc(subj.pose)}</p>` : ''}`,
  );

  const steps = arr(a.steps).length ? sec('steps', '照着拍：现场步骤', listHtml(a.steps, 'steps')) : '';
  const posing = arr(a.posing).length ? sec('pose', '给模特的指导', listHtml(a.posing)) : '';
  const pitfalls = arr(a.pitfalls).length ? sec('warn', '容易拍砸的地方', listHtml(a.pitfalls)) : '';
  const postCard =
    post.style || arr(post.adjustments).length
      ? sec(
          'post',
          '后期调色',
          `${post.style ? `<p><b>${esc(post.style)}</b></p>` : ''}
          ${post.film_sim ? `<p class="muted">胶片模拟 / 预设：${esc(post.film_sim)}</p>` : ''}
          ${arr(post.adjustments).length ? `<div class="adj">${arr(post.adjustments).map((x) => `<div><span>${esc(x.name)}</span><b>${esc(x.value)}</b></div>`).join('')}</div>` : ''}
          ${post.notes ? `<p class="muted">${esc(post.notes)}</p>` : ''}`,
        )
      : '';
  const variations = arr(a.variations).length ? sec('more', '同一场景还能这样拍', listHtml(a.variations)) : '';
  const perImage = arr(a.per_image).filter((p) => p && p.note).length
    ? sec(
        'frame',
        '每张图',
        `<div class="per-image">${arr(a.per_image)
          .filter((p) => p && p.note)
          .map((p) => `<div class="row">${ctx.images?.[p.index - 1] ? `<img src="${ctx.images[p.index - 1]}" alt="">` : `<span>#${esc(p.index)}</span>`}<span>${esc(p.note)}</span></div>`)
          .join('')}</div>`,
      )
    : '';

  const mg = a.my_gear;
  const FIT = { good: ['exif', '基本能还原'], partial: ['caption', '差一点'], poor: ['estimated', '差得多'] };
  const fit = FIT[mg?.fit];
  const myGear =
    mg && (mg.lens || mg.settings)
      ? `<div class="card mygear"><h3>${ICONS.camera}用你的器材拍 ${fit ? `<span class="badge ${fit[0]}">${fit[1]}</span>` : ''}</h3>
        ${mg.lens ? `<p class="mg-lens">${esc(mg.lens)}</p>` : ''}
        ${mg.settings ? `<p>${esc(mg.settings)}</p>` : ''}
        ${mg.gap ? `<div class="callout"><b>和原图的差距</b>${esc(mg.gap)}</div>` : ''}
        ${arr(mg.alternatives).length ? `<div class="callout"><b>备选拍法</b>${listHtml(mg.alternatives)}</div>` : ''}
      </div>`
      : '';

  const pair = (x, y) => (x && y ? `<div class="grid two">${x}${y}</div>` : x || y || '');
  return `<div class="result">
    ${hero}
    ${myGear}
    ${diagrams}
    ${exposure}
    ${pair(gearCard, lightCard)}
    ${pair(compCard, sceneCard)}
    ${steps}
    ${pair(posing, pitfalls)}
    ${postCard}
    ${pair(variations, perImage)}
    <div class="actions">
      <button class="btn primary" id="toPlanBtn">用它生成拍摄策划</button>
      <button class="btn" id="copyAnalysisBtn">复制为文字</button>
      ${state.images.length ? '<button class="btn ghost" id="reAnalyzeBtn">重新解析</button>' : ''}
    </div>
  </div>`;
}

function analysisToMarkdown(a, ctx) {
  const pv = paramValues(a, ctx?.exif?.[0]);
  const ex = a.exposure || {};
  const L = [];
  L.push(`# ${a.title || '拍法解析'}`, '', a.summary || '', '');
  L.push(`**参数：** ${[pv.gear, pv.focal, pv.aperture, pv.shutter, pv.iso].filter(Boolean).join(' ')}（${SOURCE_BADGE[pv.source]?.[1] || ''}）`);
  if (a.key_relation) L.push(`**关键关系：** ${a.key_relation}`);
  L.push('', '## 机位', a.position?.summary || '', a.position?.how_to || '');
  L.push('', '## 曝光');
  for (const [k, v] of [['光圈', ex.aperture], ['快门', ex.shutter], ['ISO', ex.iso], ['曝光补偿', ex.ev], ['白平衡', ex.white_balance], ['对焦', ex.focus]]) {
    if (v?.value) L.push(`- ${k}：${v.value}${v.why ? `（${v.why}）` : ''}`);
  }
  if (ex.mode) L.push(`- 建议模式：${ex.mode}`);
  L.push('', '## 器材', `- ${a.gear?.camera || ''}`, `- ${a.gear?.focal_length_text || ''}`, `- 手机：${a.gear?.phone || ''}`);
  L.push('', '## 光线', [a.light?.type, a.light?.direction_text, a.light?.time_of_day].filter(Boolean).join(' · '), a.light?.description || '');
  L.push('', '## 构图', arr(a.composition?.rules).join(' · '), a.composition?.description || '');
  if (arr(a.steps).length) L.push('', '## 步骤', ...arr(a.steps).map((s, i) => `${i + 1}. ${s}`));
  if (arr(a.posing).length) L.push('', '## 姿势', ...arr(a.posing).map((s) => `- ${s}`));
  if (a.post) L.push('', '## 后期', a.post.style || '', ...arr(a.post.adjustments).map((x) => `- ${x.name}：${x.value}`), a.post.notes || '');
  if (arr(a.pitfalls).length) L.push('', '## 注意', ...arr(a.pitfalls).map((s) => `- ${s}`));
  const mg = a.my_gear;
  if (mg && (mg.lens || mg.settings)) {
    L.push('', '## 用我的器材拍', mg.lens ? `- 镜头：${mg.lens}` : '', mg.settings ? `- 设置：${mg.settings}` : '', mg.gap ? `- 差距：${mg.gap}` : '', ...arr(mg.alternatives).map((s) => `- 备选：${s}`));
  }
  return L.join('\n');
}

// ================= 历史 =================
const HISTORY_KEY = 'jiwei.history';

async function saveHistory(a, ctx) {
  try {
    const thumb = ctx.images?.[0] ? await thumbOf(ctx.images[0]) : '';
    const list = store.get(HISTORY_KEY, []);
    list.unshift({ id: Date.now(), ts: Date.now(), title: a.title, sub: a.key_relation || a.summary, thumb, analysis: a, exif: ctx.exif?.[0] || null, mock: ctx.mock });
    // localStorage 有容量上限，存不下就删旧的
    while (list.length && !store.set(HISTORY_KEY, list.slice(0, 40))) list.pop();
  } catch (e) {
    console.warn('保存历史失败', e);
  }
}

function renderHistory() {
  const list = store.get(HISTORY_KEY, []);
  const box = $('#historyList');
  if (!list.length) {
    box.innerHTML = '<p class="empty">还没有解析记录。</p>';
    return;
  }
  box.innerHTML = list
    .map(
      (h) => `<div class="card h-item" data-id="${h.id}">
        ${h.thumb ? `<img src="${h.thumb}" alt="">` : ''}
        <div class="h-body">
          <span class="h-title">${esc(h.title || '未命名')}</span>
          <span class="h-sub">${esc((h.sub || '').slice(0, 60))}</span>
          <span class="h-foot"><span>${new Date(h.ts).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}${h.mock ? ' · 演示' : ''}</span><button class="del" data-del="${h.id}">删除</button></span>
        </div>
      </div>`,
    )
    .join('');
}

$('#historyList').addEventListener('click', (e) => {
  const del = e.target.closest('[data-del]');
  const list = store.get(HISTORY_KEY, []);
  if (del) {
    e.stopPropagation();
    store.set(HISTORY_KEY, list.filter((h) => String(h.id) !== del.dataset.del));
    renderHistory();
    return;
  }
  const item = e.target.closest('.h-item');
  if (!item) return;
  const h = list.find((x) => String(x.id) === item.dataset.id);
  if (!h) return;
  location.hash = '#analyze';
  $('#live').hidden = true;
  showAnalysis(h.analysis, { images: h.thumb ? [h.thumb] : [], exif: [h.exif], mock: h.mock });
  setTimeout(() => $('#result').scrollIntoView({ behavior: 'smooth' }), 50);
});
$('#clearHistoryBtn').onclick = () => {
  if (!confirm('清空全部历史解析？')) return;
  store.set(HISTORY_KEY, []);
  renderHistory();
};

// ================= 策划 =================
function renderPlanModes() {
  const modes = state.info?.planModes || { plan: '拍摄策划', video: '短视频脚本', xhs: '小红书组图' };
  $('#planModes').innerHTML = Object.entries(modes)
    .map(([k, label]) => `<button type="button" data-mode="${k}" class="${k === state.planMode ? 'active' : ''}">${esc(label)}</button>`)
    .join('');
}
$('#planModes').addEventListener('click', (e) => {
  const b = e.target.closest('[data-mode]');
  if (!b) return;
  state.planMode = b.dataset.mode;
  renderPlanModes();
});

function syncPlanRef() {
  const has = Boolean(state.analysis);
  $('#useAnalysisWrap').hidden = !has;
  if (has) $('#refTitle').textContent = state.analysis.title || '当前照片';
}

const PLAN_PREFS = 'jiwei.planPrefs';
const prefs = store.get(PLAN_PREFS, {});
if (prefs.gear) $('#gearInput').value = prefs.gear;

// ================= 我的器材 =================
function gearText(g) {
  if (!g) return '';
  return [g.camera, ...(g.lenses || []), g.phone && `手机 ${g.phone}`, g.others].filter(Boolean).join(' + ');
}

function renderGear() {
  const g = state.config?.gear || {};
  $('#gearCamera').value = g.camera || '';
  $('#gearPhone').value = g.phone || '';
  $('#gearLenses').value = (g.lenses || []).join('\n');
  $('#gearOthers').value = g.others || '';
  const has = g.camera || g.lenses?.length || g.phone;
  const lensText = g.lenses?.length ? `${g.lenses.length} 支镜头` : '';
  $('#gearLine').innerHTML = has
    ? `会按你的器材给建议：<b>${esc([g.camera, lensText, g.phone].filter(Boolean).join(' · '))}</b> <a href="#settings">修改</a>`
    : `在 <a href="#settings">设置</a> 里填上你的相机和镜头，解析会多给一张「用你的器材拍」。`;
  // 策划页的器材默认用设置里的
  if (has) $('#gearInput').value = gearText(g);
}

$('#saveGearBtn').onclick = async () => {
  const msg = $('#gearMsg');
  const gear = {
    camera: $('#gearCamera').value,
    phone: $('#gearPhone').value,
    lenses: $('#gearLenses').value.split('\n'),
    others: $('#gearOthers').value,
  };
  try {
    state.config = await api('/api/config', { gear });
    renderGear();
    msg.className = 'hint ok';
    msg.textContent = '已保存，下次解析会按这些器材给建议。';
    toast('器材已保存');
  } catch (err) {
    msg.className = 'hint err';
    msg.textContent = err.message;
  }
};

let renderQueued = false;
function renderPlan(streaming) {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    const out = $('#planOut');
    out.innerHTML = DOMPurify.sanitize(marked.parse(state.planText || ''));
    out.classList.toggle('streaming', Boolean(streaming));
  });
}

$('#planStopBtn').onclick = () => state.planCtrl?.abort();
$('#planBtn').onclick = async () => {
  const gear = $('#gearInput').value.trim();
  store.set(PLAN_PREFS, { gear });
  const body = {
    mode: state.planMode,
    brief: $('#briefInput').value.trim(),
    gear,
    extra: $('#extraInput').value.trim(),
    analysis: state.analysis && $('#useAnalysis').checked && !$('#useAnalysisWrap').hidden ? state.analysis : null,
  };
  const live = $('#planLive');
  const meta = $('#planMeta');
  live.hidden = false;
  live.className = 'card live';
  $('#planStatus').textContent = '准备中…';
  $('#planStopBtn').hidden = false;
  $('#planBtn').disabled = true;
  $('#planOut').hidden = false;
  $('#planActions').hidden = true;
  state.planText = '';
  renderPlan(true);
  const t0 = Date.now();
  let thinking = 0;
  const tick = setInterval(() => (meta.textContent = `${((Date.now() - t0) / 1000).toFixed(0)} 秒 · ${state.planText.length} 字`), 300);
  state.planCtrl = new AbortController();
  try {
    await ssePost(
      '/api/plan',
      body,
      {
        status: (d) => ($('#planStatus').textContent = d.text),
        reasoning: (d) => {
          thinking += d.delta.length;
          if (!state.planText) $('#planStatus').textContent = `AI 正在构思…（已思考 ${thinking} 字）`;
        },
        text: (d) => {
          state.planText += d.delta;
          $('#planStatus').textContent = 'AI 正在写…';
          renderPlan(true);
        },
        done: (d) => {
          live.classList.add('done');
          $('#planStatus').textContent = `完成 · ${((Date.now() - t0) / 1000).toFixed(1)} 秒${d.mock ? '（演示结果）' : ` · ${d.model}`}`;
        },
        error: (d) => {
          live.classList.add('failed');
          $('#planStatus').textContent = d.error;
        },
      },
      state.planCtrl.signal,
    );
  } catch (err) {
    live.classList.add('failed');
    $('#planStatus').textContent = err.name === 'AbortError' ? '已停止' : err.message;
  } finally {
    clearInterval(tick);
    $('#planStopBtn').hidden = true;
    $('#planBtn').disabled = false;
    state.planCtrl = null;
    renderPlan(false);
    $('#planActions').hidden = !state.planText;
    if (!state.planText) $('#planOut').hidden = true;
  }
};

$('#copyPlanBtn').onclick = () =>
  navigator.clipboard.writeText(state.planText).then(
    () => toast('已复制 Markdown'),
    () => toast('复制失败，浏览器不允许'),
  );
$('#downloadPlanBtn').onclick = () => {
  const name = (state.planText.match(/\*\*主题[:：]\*\*\s*(.+)/)?.[1] || state.analysis?.title || '拍摄策划').replace(/[\\/:*?"<>|\s]+/g, '-').slice(0, 30);
  const blob = new Blob([state.planText], { type: 'text/markdown;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${name}.md`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
};

// ================= 设置 =================
function slotForm(kind) {
  const presets = state.info.presets;
  const cfg = state.config[kind];
  const options = Object.entries(presets)
    .map(([k, p]) => `<option value="${k}" ${k === cfg.provider ? 'selected' : ''}>${esc(p.label)}</option>`)
    .join('');
  return `<div class="slot" data-kind="${kind}">
    <label class="field"><span>服务商</span><select name="provider">${options}</select></label>
    <p class="note" data-note></p>
    <div class="conn">
      <label class="field"><span>Base URL</span><input name="baseURL" value="${esc(cfg.baseURL)}" placeholder="https://…/v1" autocomplete="off"></label>
      <label class="field"><span>API Key</span>
        <span class="key-wrap"><input name="apiKey" type="password" value="${esc(cfg.apiKey)}" placeholder="${cfg.hasKey ? '已保存' : '粘贴你的 API Key'}" autocomplete="off"><button type="button" class="eye" data-eye>显示</button></span>
      </label>
      <label class="field"><span>模型</span><input name="model" value="${esc(cfg.model)}" list="models-${kind}" placeholder="模型名" autocomplete="off"><datalist id="models-${kind}"></datalist></label>
      <div class="row-btns">
        <button type="button" class="btn small" data-act="models">获取模型列表</button>
        <button type="button" class="btn small" data-act="test">测试连接</button>
        <a class="btn small ghost" data-keylink target="_blank" rel="noopener">去申请 Key ↗</a>
      </div>
      <p class="test-result hint" data-result></p>
    </div>
  </div>`;
}

function readSlot(kind) {
  const root = $(`.slot[data-kind="${kind}"]`);
  const v = (n) => root.querySelector(`[name="${n}"]`).value.trim();
  return { provider: v('provider'), baseURL: v('baseURL'), apiKey: v('apiKey'), model: v('model') };
}

function refreshSlotUI(kind, { providerChanged = false } = {}) {
  const root = $(`.slot[data-kind="${kind}"]`);
  const provider = root.querySelector('[name="provider"]').value;
  const p = state.info.presets[provider];
  const isMock = provider === 'mock';
  root.querySelector('.conn').hidden = isMock;
  root.querySelector('[data-note]').textContent = p.note || '';
  const link = root.querySelector('[data-keylink]');
  link.hidden = !p.keyUrl;
  link.href = p.keyUrl || '#';
  const suggestions = kind === 'vision' ? p.vision : p.text;
  root.querySelector('datalist').innerHTML = (suggestions || []).map((m) => `<option value="${esc(m)}">`).join('');
  if (providerChanged) {
    root.querySelector('[name="baseURL"]').value = p.baseURL || '';
    root.querySelector('[name="model"]').value = suggestions?.[0] || (isMock ? 'demo' : '');
    const key = root.querySelector('[name="apiKey"]');
    const saved = state.config[kind];
    key.value = saved.provider === provider ? saved.apiKey : '';
    key.placeholder = saved.provider === provider && saved.hasKey ? '已保存' : '粘贴你的 API Key';
    root.querySelector('[data-result]').textContent = '';
  }
}

function renderSettings() {
  $('#slot-vision').innerHTML = slotForm('vision');
  $('#slot-text').innerHTML = slotForm('text');
  $('#sameAsVision').checked = state.config.text.sameAsVision !== false;
  $('#slot-text').hidden = $('#sameAsVision').checked;
  refreshSlotUI('vision');
  refreshSlotUI('text');
  // 部署在 Cloudflare 上时，任何网络都能直接打开当前网址
  if (state.info.cloud) $('#lanHint').textContent = '用手机浏览器打开下面的地址，输入访问密码后“添加到主屏幕”，就像 App 一样用：';
  // GitHub Pages 版：没有后端，设置和 Key 存在当前浏览器里
  if (state.info.pages) $('#lanHint').textContent = '用手机浏览器打开下面的地址，“添加到主屏幕”就像 App 一样用。设置、API Key 和器材只保存在当前浏览器里，换一台设备要重新填一次：';
  const lans = state.info.pages ? [location.origin + location.pathname] : state.info.cloud ? [location.origin] : state.info.lanUrls || [];
  $('#lanList').innerHTML = lans.length ? lans.map((u) => `<li>${esc(u)}</li>`).join('') : '<li>没有检测到局域网地址</li>';
}

$('#sameAsVision').onchange = (e) => ($('#slot-text').hidden = e.target.checked);

$('#view-settings').addEventListener('change', (e) => {
  if (e.target.name === 'provider') refreshSlotUI(e.target.closest('.slot').dataset.kind, { providerChanged: true });
});

$('#view-settings').addEventListener('click', async (e) => {
  const eye = e.target.closest('[data-eye]');
  if (eye) {
    const input = eye.previousElementSibling;
    input.type = input.type === 'password' ? 'text' : 'password';
    eye.textContent = input.type === 'password' ? '显示' : '隐藏';
    return;
  }
  const act = e.target.closest('[data-act]');
  if (!act) return;
  const slot = act.closest('.slot');
  const kind = slot.dataset.kind;
  const out = slot.querySelector('[data-result]');
  const form = readSlot(kind);
  act.disabled = true;
  out.className = 'test-result hint';
  try {
    if (act.dataset.act === 'models') {
      out.textContent = '正在获取模型列表…';
      const { models } = await api('/api/models', { kind, form });
      slot.querySelector('datalist').innerHTML = models.map((m) => `<option value="${esc(m)}">`).join('');
      out.className = 'test-result hint ok';
      out.textContent = `拿到 ${models.length} 个模型，点「模型」输入框就能选。看图要选支持图片的（名字里常带 vl / vision / omni，或新一代旗舰）。`;
    } else {
      out.textContent = kind === 'vision' ? '正在发一张测试图…' : '正在测试…';
      const r = await api('/api/test', { kind, form });
      out.className = 'test-result hint ok';
      out.textContent = `连接成功${r.ms ? `（${(r.ms / 1000).toFixed(1)} 秒）` : ''}：${r.reply}`;
    }
  } catch (err) {
    out.className = 'test-result hint err';
    out.textContent = err.message;
  } finally {
    act.disabled = false;
  }
});

$('#saveSettingsBtn').onclick = async () => {
  const msg = $('#saveMsg');
  const vision = readSlot('vision');
  const text = { ...readSlot('text'), sameAsVision: $('#sameAsVision').checked };
  for (const [kind, s] of [['vision', vision], ['text', text]]) {
    if (state.config[kind].provider !== s.provider && !s.apiKey) s.clearKey = true;
  }
  if (vision.provider !== 'mock' && !vision.apiKey && !(state.config.vision.provider === vision.provider && state.config.vision.hasKey)) {
    msg.className = 'hint err';
    msg.textContent = '视觉模型还没填 API Key。';
    return;
  }
  try {
    state.config = await api('/api/config', { vision, text });
    msg.className = 'hint ok';
    msg.textContent = '已保存。';
    renderSettings();
    updateBanner();
    toast('设置已保存');
  } catch (err) {
    msg.className = 'hint err';
    msg.textContent = err.message;
  }
};

function updateBanner() {
  $('#mockBanner').hidden = state.config?.vision?.provider !== 'mock';
}

// ================= 启动 =================
async function boot() {
  route();
  renderThumbs();
  try {
    const [info, config] = await Promise.all([api('/api/info'), api('/api/config')]);
    state.info = info;
    state.config = config;
    // 网页版读不了别的网站（浏览器跨域限制），隐藏「粘贴链接」
    if (info.pages) $('.url-row').hidden = $('#urlMsg').hidden = true;
    renderPlanModes();
    renderSettings();
    renderGear();
    updateBanner();
  } catch (err) {
    toast(`连不上后端：${err.message}`, 5000);
  }
}
boot();
