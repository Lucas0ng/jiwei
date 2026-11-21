// 提示词集中放在这里，方便以后调优。

export const ANALYZE_SCHEMA = `{
  "title": "给这组照片的拍法起一个短标题，如：铁轨背影·低机位大广角",
  "summary": "一句话说清这张照片靠什么出片",
  "style_tags": ["3-6 个风格标签，如 日系", "青春", "大广角"],
  "key_relation": "用 · 连接 3-5 个关键词，如：背影前行 · 后方低机位 · 轨道汇聚线 · 大片天空",
  "scene": {
    "location": "场景类型和环境，如：废弃铁路桥，两侧护栏，远处城市天际线",
    "elements": ["画面里起作用的元素，如 铁轨引导线", "积云"]
  },
  "gear": {
    "camera": "画幅/机型推断，如：APS-C 无反（富士 X-T5）",
    "lens": "镜头类型，如：超广角定焦",
    "focal_length_text": "如：16mm（APS-C，约等效 24mm）",
    "focal_length_equiv": 24,
    "phone": "用手机怎么拍：用哪颗镜头/几倍、什么模式、要注意什么"
  },
  "exposure": {
    "source": "exif | caption | estimated 三选一：exif=照片自带参数，caption=图片上印着参数，estimated=你推断的",
    "confidence": "high | medium | low",
    "mode": "推荐的拍摄模式，如：光圈优先 A 档",
    "aperture": { "value": "f/8", "range": "f/7.1–f/11", "why": "依据，如：前后景都清楚，属于大景深" },
    "shutter": { "value": "1/200s", "range": "1/125–1/500s", "why": "" },
    "iso": { "value": "400", "range": "100–400", "why": "" },
    "ev": { "value": "-0.3 EV", "why": "" },
    "white_balance": { "value": "日光 / 约 5500K", "why": "" },
    "focus": { "value": "AF-S 单点，对在人物背部", "why": "" },
    "metering": { "value": "评价测光", "why": "" }
  },
  "position": {
    "summary": "一句话机位，如：人物正后方约 3.5 米，蹲到膝盖高度，顺着铁轨方向略仰拍",
    "distance_m": 3.5,
    "height_m": 0.4,
    "height_label": "低机位（蹲姿，约膝盖高）",
    "tilt_deg": 8,
    "how_to": "摄影师具体怎么站/蹲/趴、手怎么持机"
  },
  "subject": {
    "type": "person | people | object | landscape | architecture | animal | food | other",
    "description": "主体是什么",
    "facing": "away | toward_camera | left | right | away_left | away_right | toward_camera_left | toward_camera_right | none（从相机视角看主体朝向，left/right 指画面左右）",
    "pose": "姿势动作",
    "frame_x": 0.5,
    "frame_y": 0.55,
    "size_in_frame": "如：人物约占画面高度的一半"
  },
  "light": {
    "type": "如：自然光·晴天多云",
    "direction": "front | front_left | front_right | left | right | back_left | back_right | back | top | diffuse（光从哪来，相对相机视角：front=顺光即光在相机身后，back=逆光即光在主体身后，left/right 指画面左右）",
    "direction_text": "如：左侧逆光",
    "time_of_day": "如：下午 3–4 点",
    "quality": "硬光 / 柔光 / 混合，以及为什么",
    "description": "光线怎么塑造画面"
  },
  "composition": {
    "aspect": "如 16:9",
    "orientation": "landscape | portrait | square",
    "rules": ["用到的构图方法，如 引导线", "低角度仰拍", "天空占三分之二"],
    "horizon": "地平线/水平线位置",
    "description": "构图怎么安排的"
  },
  "steps": ["按现场执行顺序写 5-8 步，每步一句具体动作，含参数；不要在开头加序号"],
  "posing": ["给模特的指导语，没有人物就给空数组"],
  "post": {
    "style": "后期风格概括",
    "film_sim": "富士胶片模拟或预设建议，不适用写空字符串",
    "adjustments": [{ "name": "曝光", "value": "+0.3" }, { "name": "高光", "value": "-40" }],
    "notes": "调色要点"
  },
  "my_gear": {
    "fit": "good | partial | poor（用户的器材能不能复刻：good=基本能还原，partial=差一点，poor=差很多）",
    "lens": "用他的哪支镜头、放在多少焦段，注意画幅换算，如：XF 16mm f/2.8，等效 24mm，和原图一致",
    "settings": "按他的机身写出完整设置：拍摄模式、光圈、快门、ISO、对焦、测光，以及机身特有的功能（如富士胶片模拟、索尼创意外观）",
    "gap": "和原图的差距以及补救办法（焦段不够就后退/裁切/接片，光圈不够就换机位拉开背景）；没有差距写空字符串",
    "alternatives": ["用他的其他镜头或手机的备选拍法，1-2 条"]
  },
  "pitfalls": ["最容易拍砸的 2-4 个点"],
  "variations": ["同一场景还能拍的 3 个变化"],
  "per_image": [{ "index": 1, "note": "多张图时每张一句说明；只有一张时给空数组" }]
}`;

export function analyzeSystemPrompt() {
  return `你是一位资深摄影师和摄影指导，擅长从一张成片反推出它是怎么拍的：机位、焦段、光圈、快门、ISO、光线、构图、姿势和后期。你的读者是想复刻这张照片的普通摄影爱好者，可能用相机，也可能只有手机。

工作方法：
1. 参数来源的优先级：照片 EXIF（如果提供）> 图片里印着的参数文字（如“16mm f8 1/200s iso400”）> 你的视觉推断。exposure.source 如实标注。EXIF 或图片标注给出的数值直接采用，不要改写。
2. 推断时讲依据：景深和背景虚化推光圈；动态凝固或拖影推快门；噪点、光照强度推 ISO；透视畸变、空间压缩、近大远小推等效焦段；地平线位置和透视推机位高度与俯仰角；主体在画面中的大小结合焦段推拍摄距离。
3. 数值给“最可能值 + 合理范围”。distance_m、height_m、tilt_deg、focal_length_equiv、frame_x、frame_y 必须是数字。frame_x/frame_y 是主体中心在画面里的位置（0 到 1，左上角为 0,0）。tilt_deg 正数表示仰拍，负数表示俯拍。
4. 机位要具体到摄影师能照做：站在主体哪一侧、离多远、相机离地多高、镜头朝哪、身体什么姿势。
5. 光线方向用相机视角描述：front=顺光（光源在相机身后），back=逆光（光源在主体身后），left/right 指画面左右侧。
6. 用户提供了自己的器材时，my_gear 要针对这些具体型号来写：做画幅换算（APS-C 约 1.5 倍，富士/索尼 APS-C 1.5、佳能 APS-C 1.6、M43 2 倍），考虑镜头的焦段范围和最大光圈、机身特有功能。只用他拥有的镜头，不要推荐他没有的。gear.phone 里如果知道他的手机型号，就按那台手机的镜头来写。用户没有提供器材时，my_gear 设为 null。
7. 写中文，具体、可执行，不说空话。没有人物就把 posing 设为空数组。

只输出一个 JSON 对象，不要 markdown 代码块，不要任何解释文字。结构如下（注释性文字是填写说明，替换成真实内容）：
${ANALYZE_SCHEMA}`;
}

function formatExif(exif) {
  if (!exif) return '';
  const parts = [];
  const add = (k, v) => v !== undefined && v !== null && v !== '' && v !== false && parts.push(`${k}: ${v}`);
  add('相机', [exif.Make, exif.Model].filter(Boolean).join(' '));
  add('镜头', exif.LensModel);
  add('焦距', exif.FocalLength && `${Number(Number(exif.FocalLength).toFixed(1))}mm`);
  add('等效焦距', exif.FocalLengthIn35mmFormat && `${exif.FocalLengthIn35mmFormat}mm`);
  add('光圈', exif.FNumber && `f/${Number(Number(exif.FNumber).toFixed(1))}`);
  add('快门', exif.ExposureTime && (exif.ExposureTime >= 1 ? `${exif.ExposureTime}s` : `1/${Math.round(1 / exif.ExposureTime)}s`));
  add('ISO', exif.ISO);
  add('曝光补偿', exif.ExposureCompensation !== undefined && `${exif.ExposureCompensation} EV`);
  add('拍摄模式', exif.ExposureProgram);
  add('测光', exif.MeteringMode);
  add('白平衡', exif.WhiteBalance);
  add('闪光灯', exif.Flash);
  add('拍摄时间', exif.DateTimeOriginal);
  return parts.join('；');
}

/** 组装解析请求的用户消息（文本 + 图片）。 */
/** 把用户器材整理成一段文字，供解析和策划使用。 */
export function gearText(g) {
  if (!g) return '';
  const parts = [];
  if (g.camera) parts.push(`机身：${g.camera}`);
  if (g.lenses?.length) parts.push(`镜头：${g.lenses.join('、')}`);
  if (g.phone) parts.push(`手机：${g.phone}`);
  if (g.others) parts.push(`其他器材：${g.others}`);
  return parts.join('；');
}

export function analyzeUserContent({ images, exif = [], note, source, gear }) {
  const lines = [`请解析这 ${images.length} 张照片的拍法。`];
  if (images.length > 1) {
    lines.push('第 1 张是主图，其余几张可能是同一组拍摄的不同镜头，也可能是参考图。以主图为准填写 JSON，在 per_image 里给每张一句说明。');
  }
  exif.forEach((e, i) => {
    const s = formatExif(e);
    if (s) lines.push(`第 ${i + 1} 张照片自带 EXIF（实测值，直接采用）：${s}`);
  });
  if (source?.url) {
    lines.push(`图片来自网页：${source.url}`);
    if (source.title) lines.push(`网页标题：${source.title}`);
    if (source.text) lines.push(`网页正文节选（可能含作者写的参数或拍摄说明，有就采用）：\n${source.text.slice(0, 1500)}`);
  }
  if (note) lines.push(`用户补充：${note}`);
  const g = gearText(gear);
  lines.push(g ? `用户自己的器材（my_gear 按这些写）：${g}` : '用户没有提供自己的器材，my_gear 设为 null。');
  lines.push('按系统要求只输出 JSON。');

  return [
    { type: 'text', text: lines.join('\n') },
    ...images.map((url) => ({ type: 'image_url', image_url: { url } })),
  ];
}

export const PLAN_MODES = {
  plan: {
    label: '拍摄策划',
    instruction: `写一份可以直接拿去执行的拍摄策划，包含这些部分（用 Markdown 二级标题）：
## 主题与风格定位（一句话主题 + 3 个关键词 + 想让观众感受到什么）
## 场地与时间（场地要求和找场地的关键词；最佳光线时段，精确到几点到几点；天气备选）
## 器材与参数预设（器材清单；主要场景的焦段/光圈/快门/ISO/白平衡预设）
## 人员与服化道（分工；服装颜色、道具清单，说明为什么这么选）
## 拍摄流程（时间表，按到场—试拍—正式拍—补拍排）
## 分镜清单（Markdown 表格，列：编号 | 景别 | 机位与角度 | 焦段 | 参数 | 模特动作 | 要点；至少 8 个镜头）
## 现场注意事项与备选方案
## 后期方向（调色思路和关键参数）
## 发布建议（3 个小红书风格标题 + 10 个话题标签）`,
  },
  video: {
    label: '短视频脚本',
    instruction: `写一份短视频拍摄脚本，包含这些部分（用 Markdown 二级标题）：
## 基本信息（成片时长、画幅、节奏、BGM 风格建议）
## 故事线（开头 3 秒钩子—中段—结尾，用三四句话讲清楚）
## 分镜脚本（Markdown 表格，列：镜号 | 时长 | 景别 | 运镜 | 画面内容 | 机位与参数 | 字幕/口播 | 音效；10-16 个镜头）
## 拍摄要点（帧率、快门角度、对焦、防抖、收音）
## 剪辑要点（卡点、转场、调色、字幕样式）
## 发布建议（标题、封面帧、话题标签）`,
  },
  xhs: {
    label: '小红书组图',
    instruction: `为小红书图文笔记策划一组 9 张图，包含这些部分（用 Markdown 二级标题）：
## 笔记定位（目标人群、卖点、封面钩子）
## 九图清单（Markdown 表格，列：序号 | 作用(封面/氛围/细节/教程等) | 画面内容 | 机位与焦段 | 参数 | 模特动作 | 后期要点）
## 封面设计（构图、文字放哪、字体与配色建议）
## 拍摄顺序与时间安排
## 笔记文案（标题 3 选 1、正文 200 字左右、话题标签 10 个）`,
  },
};

export function planSystemPrompt() {
  return `你是一位经验丰富的摄影策划和短视频导演，熟悉人像、风光、街拍和小红书内容。你写的方案具体、能落地：参数给数值，时间给钟点，动作给指令，不写空话套话。用简体中文和 Markdown 输出，表格用标准 Markdown 表格语法。不要在开头寒暄，直接从第一个标题开始。`;
}

export function planUserPrompt({ mode, brief, gear, extra, analysis }) {
  const m = PLAN_MODES[mode] || PLAN_MODES.plan;
  const lines = [];
  lines.push(`任务：${m.label}`);
  if (brief) lines.push(`主题/想法：${brief}`);
  if (gear) lines.push(`可用器材：${gear}。分镜里的焦段、光圈只用这些器材能做到的，注意画幅换算。`);
  if (extra) lines.push(`其他要求：${extra}`);
  if (analysis) {
    lines.push('参考照片的拍法解析（以它为风格参考来策划，可以延展出更多镜头）：');
    lines.push(JSON.stringify(compactAnalysis(analysis)));
  }
  if (!brief && !analysis) lines.push('用户没有给主题，请自拟一个适合普通人周末完成的日系人像主题。');
  lines.push('');
  lines.push(m.instruction);
  return lines.join('\n');
}

function compactAnalysis(a) {
  // 只保留对策划有用的字段，减少 token
  const pick = (o, keys) => Object.fromEntries(keys.filter((k) => o?.[k] !== undefined).map((k) => [k, o[k]]));
  return {
    title: a.title,
    summary: a.summary,
    key_relation: a.key_relation,
    style_tags: a.style_tags,
    scene: a.scene,
    gear: a.gear,
    exposure: a.exposure && {
      aperture: a.exposure.aperture?.value,
      shutter: a.exposure.shutter?.value,
      iso: a.exposure.iso?.value,
    },
    position: pick(a.position, ['summary', 'distance_m', 'height_m', 'tilt_deg']),
    subject: pick(a.subject, ['description', 'pose']),
    light: pick(a.light, ['type', 'direction_text', 'time_of_day', 'quality']),
    composition: pick(a.composition, ['aspect', 'rules']),
    post: a.post && { style: a.post.style, film_sim: a.post.film_sim },
  };
}
