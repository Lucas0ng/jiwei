// 读取网页链接：抓标题、正文和图片，图片转成 data URL 交给前端压缩后再送模型。
// 只用 fetch、cheerio 和 Buffer，本地 Node 和 Cloudflare Worker（nodejs_compat）都能跑。
import * as cheerio from 'cheerio';
import { Buffer } from 'node:buffer';

const isIPv4 = (h) => /^\d{1,3}(\.\d{1,3}){3}$/.test(h);
const isIPv6 = (h) => h.includes(':');

const MOBILE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1';

const MAX_IMAGES = 6;
const MAX_IMAGE_BYTES = 12 * 1024 * 1024;
const MIN_IMAGE_BYTES = 12 * 1024; // 太小的多半是图标、头像

/** 从分享文案里抠出第一个链接，例如小红书的「复制本条信息…http://xhslink.com/xxx」。 */
export function extractUrl(input) {
  const m = String(input || '').match(/https?:\/\/[^\s"'<>，。！？、）)】]+/i);
  return m ? m[0] : null;
}

function isPrivateHost(hostname) {
  const h = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local')) return true;
  if (isIPv4(h)) {
    const [a, b] = h.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
  }
  if (isIPv6(h)) return h === '::1' || h.startsWith('fc') || h.startsWith('fd') || h.startsWith('fe80');
  return false;
}

async function fetchWithTimeout(url, opts = {}, ms = 15000) {
  return fetch(url, { redirect: 'follow', ...opts, signal: AbortSignal.timeout(ms) });
}

async function downloadImage(src, referer, retry = 1) {
  try {
    const res = await fetchWithTimeout(src, { headers: { 'User-Agent': MOBILE_UA, Referer: referer, Accept: 'image/avif,image/webp,image/*,*/*' } }, 15000);
    if ((res.status === 429 || res.status >= 500) && retry > 0) {
      await new Promise((r) => setTimeout(r, 1200));
      return downloadImage(src, referer, retry - 1);
    }
    if (!res.ok) return null;
    let type = (res.headers.get('content-type') || '').split(';')[0].trim();
    if (type.includes('gif') || type.includes('svg')) return null;
    if (!type.startsWith('image/')) {
      // 有些 CDN 不给正确的 content-type，按扩展名兜底
      const ext = src.split('?')[0].split('.').pop().toLowerCase();
      const map = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', avif: 'image/avif' };
      if (!map[ext]) return null;
      type = map[ext];
    }
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < MIN_IMAGE_BYTES || buf.length > MAX_IMAGE_BYTES) return null;
    return { src, dataUrl: `data:${type};base64,${buf.toString('base64')}`, bytes: buf.length };
  } catch {
    return null;
  }
}

function absolutize(src, base) {
  try {
    const u = new URL(src.trim(), base);
    if (!/^https?:$/.test(u.protocol)) return null;
    return u.href;
  } catch {
    return null;
  }
}

const NOISE = /(logo|icon|avatar|sprite|emoji|favicon|placeholder|loading|blank|pixel|qrcode|badge|banner-ad|donate|\.gif(\?|$)|\.svg(\?|$))/i;

/** 同一张图的不同尺寸（如 960px-xxx.jpg 和 xxx.jpg）算一张。 */
function imageKey(abs) {
  const u = new URL(abs);
  const base = decodeURIComponent(u.pathname.split('/').pop() || '').replace(/^\d+px-/, '');
  return base.length >= 10 ? base.toLowerCase() : u.host + u.pathname;
}

function collectImages($, html, pageUrl) {
  const found = [];
  const keys = new Set();
  const push = (src) => {
    const abs = src && absolutize(src, pageUrl);
    if (!abs || NOISE.test(abs)) return;
    const key = imageKey(abs);
    if (keys.has(key)) return;
    keys.add(key);
    found.push(abs);
  };

  // 1. 分享卡片图，通常就是主图
  $('meta[property="og:image"], meta[name="og:image"], meta[property="og:image:url"], meta[name="twitter:image"], meta[itemprop="image"]').each((_, el) => push($(el).attr('content')));

  // 2. 小红书等 SPA：图片地址藏在内联 JSON 里（斜杠被转义成 /）
  const jsonUrlRe = /"(?:urlDefault|urlPre|url|imageUrl|image_url|originUrl)"\s*:\s*"(https?:(?:\\u002F|\\\/|\/){2}[^"\s]+?)"/g;
  let m;
  while ((m = jsonUrlRe.exec(html))) {
    const u = m[1].replace(/\\u002F/g, '/').replace(/\\\//g, '/');
    if (/xhscdn|sinaimg|hdslb|douyinpic|byteimg|qpic|pstatp|\.(jpe?g|png|webp|avif)(\?|$)/i.test(u)) push(u);
  }

  // 3. 普通网页的 <img>
  $('img').each((_, el) => {
    const $el = $(el);
    const w = Number($el.attr('width') || 0);
    if (w && w < 120) return;
    push($el.attr('data-src') || $el.attr('data-original') || $el.attr('data-lazy-src') || $el.attr('src'));
    const srcset = $el.attr('srcset') || $el.attr('data-srcset');
    if (srcset) {
      // 取 srcset 里最大的一张
      const best = srcset
        .split(',')
        .map((s) => s.trim().split(/\s+/))
        .sort((a, b) => parseFloat(b[1] || 0) - parseFloat(a[1] || 0))[0];
      if (best) push(best[0]);
    }
  });
  return found;
}

export async function fetchPage(input) {
  const url = extractUrl(input);
  if (!url) throw new Error('没有识别到链接，请粘贴以 http 开头的网址。');
  const u = new URL(url);
  if (isPrivateHost(u.hostname)) throw new Error('不支持读取内网地址。');

  let res;
  try {
    res = await fetchWithTimeout(url, {
      headers: { 'User-Agent': MOBILE_UA, Accept: 'text/html,application/xhtml+xml,image/*;q=0.9,*/*;q=0.8', 'Accept-Language': 'zh-CN,zh;q=0.9' },
    });
  } catch (err) {
    throw new Error(`打不开这个链接：${err.cause?.code || err.message}`);
  }
  if (!res.ok) throw new Error(`网页返回 HTTP ${res.status}，可能需要登录或做了防爬。可以截图后直接上传。`);

  const finalUrl = res.url || url;
  const type = res.headers.get('content-type') || '';

  // 链接本身就是一张图片
  if (type.startsWith('image/')) {
    const img = await downloadImage(finalUrl, finalUrl);
    if (!img) throw new Error('图片下载失败或太小。');
    return { url: finalUrl, title: '', text: '', images: [img], warnings: [] };
  }

  const html = await res.text();
  const $ = cheerio.load(html);
  const meta = (sel) => $(sel).attr('content')?.trim() || '';
  const title = meta('meta[property="og:title"]') || $('title').first().text().trim();
  const description = meta('meta[property="og:description"]') || meta('meta[name="description"]');

  $('script, style, noscript, svg, header, footer, nav').remove();
  const bodyText = $('article').text() || $('main').text() || $('body').text();
  const text = [description, bodyText.replace(/\s+/g, ' ').trim()].filter(Boolean).join('\n').slice(0, 3000);

  const candidates = collectImages(cheerio.load(html), html, finalUrl).slice(0, 16);
  const downloaded = (await Promise.all(candidates.map((src) => downloadImage(src, finalUrl)))).filter(Boolean);
  // 同一张图常有多个尺寸的地址，按字节数去重
  const seen = new Set();
  const images = downloaded.filter((img) => (seen.has(img.bytes) ? false : seen.add(img.bytes))).slice(0, MAX_IMAGES);

  const warnings = [];
  if (!images.length && candidates.length) {
    warnings.push(`网页里找到 ${candidates.length} 张图，但都没下载下来（可能被限流或防盗链）。稍后再试，或截图后直接上传。`);
  } else if (!images.length) {
    warnings.push('这个网页没读到可用的图片（可能需要登录、做了防爬，或图片是动态加载的）。可以截图后直接上传。');
  }
  return { url: finalUrl, title, text, images, warnings };
}
