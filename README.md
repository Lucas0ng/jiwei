# 机位 · 照片拍法解析

上传照片（或粘贴小红书 / 网页 / 图片链接），AI 反推这张照片是怎么拍的：机位、焦段、光圈、快门、ISO、光线、构图、姿势和后期，并画出俯视站位图和侧面机位图。解析结果可以一键生成拍摄策划、短视频分镜脚本或小红书组图方案。

## 启动

需要 Node.js 20 以上。

```bash
cd ~/projects/jiwei
npm install
npm start
```

浏览器打开 http://localhost:8787 。终端里会打印一个 `http://192.168.x.x:8787` 的地址，手机和电脑连同一个 Wi-Fi 后用手机打开它，Safari 里点「分享 → 添加到主屏幕」，就能像 App 一样用，还能直接调相机拍照解析。

第一次打开是**演示模式**，返回的是内置示例结果，用来看效果。

## 接入 AI

打开页面右上角「设置」，选服务商、填 API Key、选模型，点「测试连接」确认能看图，再点「保存设置」。Key 只保存在本机的 `config.local.json`（已加入 `.gitignore`），网页上只显示打码后的值。

| 用途 | 推荐 | 说明 |
|---|---|---|
| 看图解析 | 阿里云百炼 · `qwen3.8-flash`（当前配置） | 国内直连，原生支持图片。实测示例图：默认快速模式约 25–30 秒，打开「深度思考」约 45 秒。Key 在 [百炼控制台](https://bailian.console.aliyun.com/?tab=model#/api-key) 申请。 |
| 写策划、脚本 | 同上 | 写策划时自动关闭思考，约 40 秒写完、1 秒出第一个字。也可以取消勾选「和视觉模型用同一个」换成 DeepSeek `deepseek-flash`。 |

实测对比（同一张铁轨图）：`qwen3.7-plus` 约 45 秒、质量相近；`qwen3.8-max` 要 2 分钟以上，不适合实时用。DeepSeek 的 `deepseek-flash` 也能看图，但每张图最多按约 1300×1300 像素处理，细节判断弱一些。

其他可选：智谱 `glm-4.6v`（`glm-4.6v-flash` 免费）、豆包（方舟控制台复制模型名）、Gemini、Grok、OpenAI、OpenRouter，以及任意 OpenAI 兼容接口。模型名更新很快，设置页的「获取模型列表」会直接拉服务商当前的模型。

也可以用环境变量提供 Key，不写进文件：`JIWEI_VISION_API_KEY=xxx JIWEI_TEXT_API_KEY=yyy npm start`。

## 我的器材

在「设置 → 我的器材」里填机身、镜头（一行一支）、手机和其他器材，保存在本机配置里，电脑和手机打开都能用上。填了之后：

- 解析结果在最上面多一张「用你的器材拍」：用哪支镜头、多少焦段（会做画幅换算）、机身怎么设置，以及和原图的差距、补救办法和备选拍法。
- 写策划时默认带上这些器材，分镜里只会用你有的焦段。

## 解析准确度

参数的可信度按来源分三级，结果页会标出来：

1. **EXIF 实测**：上传原图（不是截图、不是微信压缩过的图）时，直接读照片里记录的光圈、快门、ISO、焦距、机型。
2. **图片标注**：图片里印着参数（比如示例图上的「16mm f8 1/200s iso400」），AI 会照抄。
3. **AI 推断**：根据景深推光圈、动态推快门、噪点推 ISO、透视推焦段和机位，并给出范围和依据。

机位示意图是按 AI 估算的距离、机位高度、俯仰角和等效焦段计算视角画出来的，用来理解站位，不是精确测量。

## 读取链接

支持普通网页、图片直链，以及小红书分享文案（会自动抠出里面的链接）。服务端会抓取网页标题、正文和图片，正文里如果写了参数也会交给 AI 参考。需要登录或防爬严格的页面可能读不到图，这时截图上传即可。

## 部署到 Cloudflare

同一套代码也能跑在 Cloudflare Workers 上，部署后不用开电脑，手机在任何网络下都能用。和本地版的区别：

- 打开网站要先输入**访问密码**（Secret `JIWEI_PASSWORD`），防止别人用你的 API Key。每台设备登录一次保持 180 天。
- 设置（模型、Key、我的器材）存在 Cloudflare KV 里，登录后在「设置」页填写，和本地一样。也可以用 Secret `JIWEI_VISION_API_KEY` / `JIWEI_TEXT_API_KEY` 提供 Key，Secret 优先。
- `*.workers.dev` 域名在国内网络经常打不开，不开代理要用的话，在 Cloudflare 上给它绑一个自己的域名（Worker → Settings → Domains & Routes）。

第一次部署：

```bash
npx wrangler login
npx wrangler secret put JIWEI_PASSWORD
npm run cf:deploy
```

以后改了代码，再跑一次 `npm run cf:deploy` 即可。本地预览 Worker 版用 `npm run cf:dev`（访问密码写在 `.dev.vars` 里，格式 `JIWEI_PASSWORD=xxx`）。

## 网页版（GitHub Pages）

纯静态版本，托管在 GitHub Pages 上，不需要服务器，国内网络一般也能直接打开。和其他两个版本的区别：

- 没有后端：解析和策划由**浏览器直接调用模型服务商**。千问、DeepSeek、豆包、Gemini、OpenAI、OpenRouter、Grok 实测允许浏览器直连；智谱不允许，网页版用不了。
- 没有访问密码：每个访问者在「设置」里填自己的 API Key，Key、模型设置和器材只保存在**各自浏览器**的 localStorage 里，换设备要重填。
- 不能「粘贴链接读取」（浏览器不允许网页抓取别的网站），网页版隐藏了这个入口，截图上传即可。

推送到 `main` 分支后，GitHub Actions（`.github/workflows/pages.yml`）会自动打包并发布。本地预览：`npm run pages:preview`，打开 http://localhost:8789 。

## 目录

```
server/
  index.js      Express 服务（本地运行）：静态文件 + /api 接口
  core.js       解析（SSE 流式）、策划（SSE 流式）、测试连接，本地和 Cloudflare 共用
  llm.js        OpenAI 兼容的流式调用、错误提示、模型列表
  prompts.js    解析和策划的提示词、输出 JSON 结构（调效果主要改这里）
  fetchPage.js  网页 / 小红书链接的图片和文字提取
  settings.js   服务商预设、设置合并、Key 打码
  config.js     本地设置存储（config.local.json）
  mock.js       演示模式的示例结果
worker/
  index.js      Cloudflare Worker 入口：访问密码、KV 设置、/api 接口
pages/
  api.js        GitHub Pages 版：在浏览器里处理 /api/* 请求，设置存 localStorage
  boot.js       GitHub Pages 版入口
scripts/
  build-cf.mjs     把 public/、samples/ 和前端依赖打包到 dist/ 供 Cloudflare 托管
  build-pages.mjs  打包纯静态的 GitHub Pages 版到 site/
wrangler.jsonc  Cloudflare 配置
public/
  index.html  styles.css  app.js
  diagram.js    俯视站位图、侧面机位图（纯 SVG）
samples/        示例图
```

开发时用 `npm run dev`，改了服务端代码会自动重启。
