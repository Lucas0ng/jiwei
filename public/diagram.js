// 根据解析结果画两张示意图：俯视站位、侧面机位。纯 SVG 字符串，颜色走 CSS 变量，深浅色都能看。

const FACING_DEG = {
  away: 0,
  away_right: 45,
  right: 90,
  toward_camera_right: 135,
  toward_camera: 180,
  toward_camera_left: 225,
  left: 270,
  away_left: 315,
};
const FACING_TEXT = {
  away: '背向镜头',
  away_right: '背向偏右',
  right: '朝画面右',
  toward_camera_right: '朝镜头偏右',
  toward_camera: '面向镜头',
  toward_camera_left: '朝镜头偏左',
  left: '朝画面左',
  away_left: '背向偏左',
};
// 光从哪个方向来（俯视图里，0 = 主体身后远处，180 = 相机身后）
const LIGHT_DEG = {
  back: 0,
  back_right: 45,
  right: 90,
  front_right: 135,
  front: 180,
  front_left: 225,
  left: 270,
  back_left: 315,
};
const LIGHT_TEXT = {
  back: '逆光',
  back_right: '右侧逆光',
  right: '右侧光',
  front_right: '右前侧光',
  front: '顺光',
  front_left: '左前侧光',
  left: '左侧光',
  back_left: '左侧逆光',
  top: '顶光',
  diffuse: '散射光',
};

const rad = (d) => (d * Math.PI) / 180;
const num = (v, d) => (Number.isFinite(Number(v)) && v !== '' && v !== null ? Number(v) : d);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const r1 = (v) => Math.round(v * 10) / 10;
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

function aspectRatio(text, orientation) {
  const m = String(text || '').match(/(\d+(?:\.\d+)?)\s*[:：x×]\s*(\d+(?:\.\d+)?)/);
  let r = m ? Number(m[1]) / Number(m[2]) : orientation === 'square' ? 1 : 1.5;
  if (!Number.isFinite(r) || r <= 0) r = 1.5;
  return r >= 1 ? r : 1 / r;
}

/** 由等效焦距和画幅算水平/垂直视角（度）。 */
export function fieldOfView(a) {
  const f = clamp(num(a?.gear?.focal_length_equiv, 35), 8, 1200);
  const orientation = a?.composition?.orientation || 'landscape';
  const r = aspectRatio(a?.composition?.aspect, orientation);
  // 以 36mm 长边为基准，按画面比例裁切短边
  const long = 36;
  const short = long / r;
  const w = orientation === 'portrait' ? short : long;
  const h = orientation === 'portrait' ? long : short;
  return { h: (2 * Math.atan(w / 2 / f) * 180) / Math.PI, v: (2 * Math.atan(h / 2 / f) * 180) / Math.PI, f };
}

function cameraIcon(x, y, rotateDeg = 0) {
  return `<g transform="translate(${x} ${y}) rotate(${rotateDeg})">
    <rect x="-14" y="-9" width="28" height="18" rx="4" class="dg-cam"/>
    <rect x="-6" y="-15" width="12" height="7" rx="2" class="dg-cam"/>
    <circle cx="0" cy="0" r="5" class="dg-lens"/>
  </g>`;
}

function sunIcon(x, y) {
  const rays = Array.from({ length: 8 }, (_, i) => {
    const t = rad(i * 45);
    return `<line x1="${r1(x + Math.cos(t) * 11)}" y1="${r1(y + Math.sin(t) * 11)}" x2="${r1(x + Math.cos(t) * 16)}" y2="${r1(y + Math.sin(t) * 16)}" class="dg-sun-ray"/>`;
  }).join('');
  return `<g><circle cx="${r1(x)}" cy="${r1(y)}" r="8" class="dg-sun"/>${rays}</g>`;
}

function cloudIcon(x, y) {
  return `<path d="M${x - 16} ${y + 6} a8 8 0 0 1 4-15 a10 10 0 0 1 19-2 a7 7 0 0 1 9 11 z" class="dg-cloud"/>`;
}

const ARROW_DEFS = `<defs>
  <marker id="dg-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0 L10 5 L0 10 z" class="dg-arrowhead"/></marker>
  <marker id="dg-arrow-sun" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0 L10 5 L0 10 z" class="dg-sun"/></marker>
</defs>`;

/** 俯视站位图：相机在下方朝上拍，画出视角范围、主体位置和朝向、光源方向。 */
export function topView(a) {
  const W = 340;
  const H = 300;
  const cam = { x: W / 2, y: 262 };
  const fov = fieldOfView(a);
  const d = clamp(num(a?.position?.distance_m, 3), 0.2, 500);
  // 主体固定画在相机前方 175px，距离用文字标出（否则近距离俯拍时主体会压在相机上）
  const s = 175 / d; // 像素/米
  const fx = clamp(num(a?.subject?.frame_x, 0.5), 0, 1);
  const theta = rad((fx - 0.5) * fov.h);
  const subj = { x: clamp(cam.x + d * Math.tan(theta) * s, 30, W - 30), y: cam.y - d * s };

  // 视角范围
  const half = rad(Math.min(fov.h, 170) / 2);
  const L = Math.min(250, d * s * 1.5 + 30);
  const left = { x: cam.x - Math.sin(half) * L, y: cam.y - Math.cos(half) * L };
  const right = { x: cam.x + Math.sin(half) * L, y: cam.y - Math.cos(half) * L };

  const parts = [ARROW_DEFS];
  parts.push(`<polygon points="${cam.x},${cam.y} ${r1(left.x)},${r1(left.y)} ${r1(right.x)},${r1(right.y)}" class="dg-fov"/>`);
  parts.push(`<line x1="${cam.x}" y1="${cam.y}" x2="${r1(left.x)}" y2="${r1(left.y)}" class="dg-fov-edge"/>`);
  parts.push(`<line x1="${cam.x}" y1="${cam.y}" x2="${r1(right.x)}" y2="${r1(right.y)}" class="dg-fov-edge"/>`);
  parts.push(`<text x="${r1(Math.min(right.x - 4, W - 6))}" y="${r1(clamp(right.y + 14, 14, H - 50))}" class="dg-small" text-anchor="end">视角约 ${Math.round(fov.h)}°</text>`);

  // 拍摄方向线 + 距离
  parts.push(`<line x1="${cam.x}" y1="${cam.y - 16}" x2="${r1(subj.x)}" y2="${r1(subj.y + 14)}" class="dg-shot" marker-end="url(#dg-arrow)"/>`);
  const mid = { x: (cam.x + subj.x) / 2, y: (cam.y + subj.y) / 2 };
  parts.push(`<text x="${r1(mid.x + 10)}" y="${r1(mid.y)}" class="dg-label">≈ ${r1(d)} m</text>`);

  // 光源
  const dir = a?.light?.direction;
  if (dir && LIGHT_DEG[dir] !== undefined) {
    const R = 92;
    // 顺光/逆光正好落在拍摄线和朝向箭头上，稍微错开一点免得重叠
    const deg = LIGHT_DEG[dir] === 180 ? 205 : LIGHT_DEG[dir] === 0 ? 25 : LIGHT_DEG[dir];
    const t = rad(deg);
    const sx = clamp(subj.x + Math.sin(t) * R, 22, W - 22);
    const sy = clamp(subj.y - Math.cos(t) * R, 22, H - 22);
    const len = Math.hypot(subj.x - sx, subj.y - sy) || 1;
    const ex = subj.x - ((subj.x - sx) / len) * 26;
    const ey = subj.y - ((subj.y - sy) / len) * 26;
    parts.push(`<line x1="${r1(sx + ((subj.x - sx) / len) * 20)}" y1="${r1(sy + ((subj.y - sy) / len) * 20)}" x2="${r1(ex)}" y2="${r1(ey)}" class="dg-sun-line" marker-end="url(#dg-arrow-sun)"/>`);
    parts.push(sunIcon(sx, sy));
    const anchor = sx < W / 2 ? 'start' : 'end';
    parts.push(`<text x="${r1(sx + (anchor === 'start' ? -12 : 12))}" y="${r1(sy + (sy < 40 ? 32 : -22))}" class="dg-small dg-sun-text" text-anchor="${anchor}">${esc(LIGHT_TEXT[dir])}</text>`);
  } else if (dir === 'top' || dir === 'diffuse') {
    const ix = clamp(subj.x + 56, 30, W - 30);
    const iy = clamp(subj.y - 40, 26, H - 30);
    parts.push(dir === 'top' ? sunIcon(ix, iy) : cloudIcon(ix, iy));
    parts.push(`<text x="${ix}" y="${iy + 30}" class="dg-small dg-sun-text" text-anchor="middle">${LIGHT_TEXT[dir]}</text>`);
  }

  // 主体
  const type = a?.subject?.type || 'person';
  const facing = a?.subject?.facing;
  if (['person', 'people', 'animal'].includes(type)) {
    if (facing && FACING_DEG[facing] !== undefined) {
      const t = rad(FACING_DEG[facing]);
      parts.push(`<line x1="${r1(subj.x)}" y1="${r1(subj.y)}" x2="${r1(subj.x + Math.sin(t) * 30)}" y2="${r1(subj.y - Math.cos(t) * 30)}" class="dg-facing" marker-end="url(#dg-arrow)"/>`);
    }
    parts.push(`<circle cx="${r1(subj.x)}" cy="${r1(subj.y)}" r="11" class="dg-subject"/>`);
    if (type === 'people') parts.push(`<circle cx="${r1(subj.x + 16)}" cy="${r1(subj.y + 6)}" r="9" class="dg-subject"/>`);
  } else {
    parts.push(`<rect x="${r1(subj.x - 11)}" y="${r1(subj.y - 11)}" width="22" height="22" rx="4" transform="rotate(45 ${r1(subj.x)} ${r1(subj.y)})" class="dg-subject"/>`);
  }
  const subjLabel = FACING_TEXT[facing] ? `主体 · ${FACING_TEXT[facing]}` : '主体';
  const labelLeft = subj.x > W / 2;
  parts.push(`<text x="${r1(subj.x + (labelLeft ? -18 : 18))}" y="${r1(subj.y + 4)}" class="dg-label" text-anchor="${labelLeft ? 'end' : 'start'}">${esc(subjLabel)}</text>`);

  // 相机
  parts.push(cameraIcon(cam.x, cam.y));
  const h = num(a?.position?.height_m, null);
  parts.push(`<text x="${cam.x}" y="${cam.y + 28}" class="dg-label" text-anchor="middle">相机${h !== null ? ` · 离地 ${r1(h)} m` : ''}</text>`);

  return `<svg viewBox="0 0 ${W} ${H}" class="diagram" role="img" aria-label="俯视站位示意图">${parts.join('')}</svg>`;
}

/** 侧面机位图：相机高度、俯仰角、垂直视角、与主体的距离。 */
export function sideView(a) {
  const W = 340;
  const H = 210;
  const ground = 178;
  const camX = 46;
  const fov = fieldOfView(a);
  const d = clamp(num(a?.position?.distance_m, 3), 0.2, 500);
  const hCam = clamp(num(a?.position?.height_m, 1.5), 0, 500);
  const tilt = clamp(num(a?.position?.tilt_deg, 0), -90, 90);
  const type = a?.subject?.type || 'person';
  const subjH = { person: 1.65, people: 1.65, animal: 0.5, object: 0.6, food: 0.25, architecture: 12, landscape: 0, other: 1 }[type] ?? 1;

  // distance_m 是沿镜头方向的直线距离，侧视图里换算成水平距离（俯拍美食时相机基本在主体正上方）
  const hd = Math.max(d * Math.cos(rad(tilt)), 0.05);
  const s = Math.min(90, 250 / Math.max(hd, 0.3), 145 / Math.max(hCam, subjH, 0.5));
  const subjX = camX + hd * s;
  const camY = ground - hCam * s;

  const parts = [ARROW_DEFS];
  // 地面
  parts.push(`<line x1="10" y1="${ground}" x2="${W - 10}" y2="${ground}" class="dg-ground"/>`);
  for (let x = 16; x < W - 10; x += 14) parts.push(`<line x1="${x}" y1="${ground}" x2="${x - 6}" y2="${ground + 6}" class="dg-hatch"/>`);

  // 垂直视角 + 光轴（SVG 的 y 轴向下，所以仰角取负）
  const L = 300;
  const up = rad(tilt + fov.v / 2);
  const down = rad(tilt - fov.v / 2);
  const p = (ang) => ({ x: camX + Math.cos(ang) * L, y: camY - Math.sin(ang) * L });
  const pu = p(up);
  const pd = p(down);
  parts.push(`<polygon points="${camX},${r1(camY)} ${r1(pu.x)},${r1(pu.y)} ${r1(pd.x)},${r1(pd.y)}" class="dg-fov"/>`);
  parts.push(`<line x1="${camX}" y1="${r1(camY)}" x2="${r1(pu.x)}" y2="${r1(pu.y)}" class="dg-fov-edge"/>`);
  parts.push(`<line x1="${camX}" y1="${r1(camY)}" x2="${r1(pd.x)}" y2="${r1(pd.y)}" class="dg-fov-edge"/>`);
  const axis = p(rad(tilt));
  parts.push(`<line x1="${camX}" y1="${r1(camY)}" x2="${r1(axis.x)}" y2="${r1(axis.y)}" class="dg-axis"/>`);

  // 主体
  if (type === 'landscape') {
    parts.push(`<path d="M${W - 150} ${ground} L${W - 100} ${ground - 40} L${W - 70} ${ground - 18} L${W - 40} ${ground - 52} L${W - 10} ${ground} Z" class="dg-subject-soft"/>`);
  } else if (['person', 'people'].includes(type)) {
    const ph = subjH * s;
    const head = Math.max(3, ph * 0.08);
    parts.push(`<g class="dg-person">
      <circle cx="${r1(subjX)}" cy="${r1(ground - ph + head)}" r="${r1(head)}" class="dg-subject"/>
      <rect x="${r1(subjX - ph * 0.09)}" y="${r1(ground - ph + head * 2.1)}" width="${r1(ph * 0.18)}" height="${r1(ph * 0.45)}" rx="${r1(ph * 0.05)}" class="dg-subject"/>
      <rect x="${r1(subjX - ph * 0.07)}" y="${r1(ground - ph * 0.47)}" width="${r1(ph * 0.14)}" height="${r1(ph * 0.47)}" rx="${r1(ph * 0.03)}" class="dg-subject"/>
    </g>`);
  } else {
    const oh = Math.max(subjH * s, 8);
    parts.push(`<rect x="${r1(subjX - oh * 0.4)}" y="${r1(ground - oh)}" width="${r1(oh * 0.8)}" height="${r1(oh)}" rx="3" class="dg-subject"/>`);
  }

  // 机位高度标注
  if (hCam > 0.05) {
    parts.push(`<line x1="${camX - 26}" y1="${r1(camY)}" x2="${camX - 26}" y2="${ground}" class="dg-dim" marker-start="url(#dg-arrow)" marker-end="url(#dg-arrow)"/>`);
  }
  parts.push(`<text x="${camX - 30}" y="${r1(Math.min((camY + ground) / 2 + 4, ground - 4))}" class="dg-small" text-anchor="end" transform="rotate(-90 ${camX - 30} ${r1(Math.min((camY + ground) / 2 + 4, ground - 4))})">${r1(hCam)} m</text>`);

  // 距离标注
  if (type !== 'landscape' && subjX - camX >= 40) {
    parts.push(`<line x1="${camX}" y1="${ground + 16}" x2="${r1(subjX)}" y2="${ground + 16}" class="dg-dim" marker-start="url(#dg-arrow)" marker-end="url(#dg-arrow)"/>`);
    parts.push(`<text x="${r1((camX + subjX) / 2)}" y="${ground + 30}" class="dg-small" text-anchor="middle">≈ ${r1(hd)} m</text>`);
  } else if (type !== 'landscape') {
    parts.push(`<text x="${r1(subjX + 24)}" y="${ground - 6}" class="dg-small">相距 ≈ ${r1(d)} m</text>`);
  }

  // 相机（按俯仰角旋转）
  parts.push(cameraIcon(camX, camY, -tilt + 90));
  const tiltText = Math.abs(tilt) < 2 ? '平视' : tilt > 0 ? `仰拍 ${Math.round(tilt)}°` : `俯拍 ${Math.round(-tilt)}°`;
  parts.push(`<text x="${camX + 18}" y="${r1(Math.max(camY - 16, 14))}" class="dg-label">${tiltText} · 垂直视角 ${Math.round(fov.v)}°</text>`);

  return `<svg viewBox="0 0 ${W} ${H}" class="diagram" role="img" aria-label="侧面机位示意图">${parts.join('')}</svg>`;
}

export { LIGHT_TEXT, FACING_TEXT };
