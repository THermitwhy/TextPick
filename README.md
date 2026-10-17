# 拾字 · Chrome 图片 OCR

Manifest V3 扩展。在图片右键菜单中选择 **提取文字（本地 OCR）**，识别完成后，图片上会生成可选择的文字层。支持拖选后 Ctrl/Cmd+C、复制全文、文字显隐，以及查看和编辑全文。

## 直接安装

本工作区已经准备好 `dist`，包含 PaddleOCR PP-OCRv5 mobile 检测/识别模型，以及 Tesseract fast、best 两套中英文模型和 WASM 运行库：

1. Chrome 打开 `chrome://extensions`，开启「开发者模式」。
2. 点击「加载已解压的扩展程序」，选择此项目的 **dist** 目录。
3. 刷新要使用的网页，右键图片，选择「提取文字（本地 OCR）」。
4. 点击扩展图标，在「本地 OCR 引擎」中选择 PaddleOCR 或 Tesseract.js。选 Tesseract 后，可继续选择 `tessdata_best`（精度优先、较慢）或 `tessdata_fast`（速度优先），保存后下次提取生效。
5. 识别结果提示中会显示本次实际使用的模型，便于对同一张图片做对比。语言和版面模式保持一致时更容易判断差异。

默认使用 **PaddleOCR PP-OCRv5 mobile**，支持中英文混合；Tesseract 专用语言和版面设置对 PaddleOCR 不生效。右键菜单仅保留「提取文字（本地 OCR）」一个入口，所有引擎和模型配置都放在扩展弹出菜单中。已安装旧版本时，先在 `chrome://extensions` 点击扩展的「重新加载」，再刷新图片所在网页；旧的右键模型菜单会自动清除。Tesseract 两个模型的缓存已隔离，切换后不会复用另一套模型的数据。已经开始或排队的任务仍使用提交时的配置。

打开本地图片文件时，需要在扩展详情中启用「允许访问文件网址」。首次加载已有网页必须刷新；Chrome 内部页面、Chrome 网上应用店及其他禁止内容脚本的页面不能叠加文字层。

默认文字层透明，拖选时会出现蓝色选择背景；「显示文字」可以检查识别位置和结果。再次提取会替换当前 frame 的文字层；关闭浮层只关闭显示，已开始的任务会在后台完成并释放 Worker。

## 从源码构建

使用 Node.js 24.5+ 和 npm。下载只发生在安装 / 构建准备阶段，实际 OCR 不需要互联网，也不会上传图片到 OCR 服务。

```powershell
npm ci --ignore-scripts
npm run models
npm run build
npm run check
npm test
```

`npm run models` 从官方 `tesseract-ocr/tessdata_fast`、`tesseract-ocr/tessdata_best` 仓库下载 `eng`、`chi_sim`，使用固定提交。fast 压缩后约 3.7 MB，best 约 24.8 MB；已下载且哈希正确的模型会跳过下载。best 放在 `models/best`，fast 保留在 `models` 根目录。脚本支持 Node 的 `HTTP_PROXY` / `HTTPS_PROXY` 环境变量。若 npm 需要代理，可使用已有环境配置：

```powershell
npm ci --ignore-scripts --proxy=$env:HTTP_PROXY --https-proxy=$env:HTTPS_PROXY
```

模型下载脚本记录 SHA-256 到 `models/models.lock.json`；构建时校验四个模型文件。已下载模型可重复构建，不需要再次下载。固定版本的 npm 依赖由 `package-lock.json` 锁定。模型和运行库许可证保留在输出目录的 `models/LICENSE`、`models/best/LICENSE`、`licenses` 下。

`npm run models` 也会下载 PaddleOCR 官方 PP-OCRv5 mobile 的检测和识别 ONNX 模型包，约 21.5 MB，包含配套 YAML 和识别字典，存于 `models/paddle`。来源及 SHA-256 记录在该目录的 `models.lock.json`，构建时校验。可单独运行 `node --use-env-proxy scripts/download-paddle-models.mjs` 准备 Paddle 模型。扩展运行时全部使用包内资源，不连接 PaddleOCR/CDN 下载模型或脚本。

## 为什么选择这个本地方案

**WASM 化的是推理引擎，模型权重作为数据加载。** 支持 PaddleOCR.js 0.4.2 + ONNX Runtime Web WASM，以及 Tesseract.js 6.0.1 + Tesseract LSTM 模型，无需原生程序或本地 HTTP 服务。

| 路线 | 浏览器本地运行方式 | 当前取舍 |
| --- | --- | --- |
| [Tesseract.js](https://github.com/naptha/tesseract.js) + [tessdata_fast](https://github.com/tesseract-ocr/tessdata_fast) / [tessdata_best](https://github.com/tesseract-ocr/tessdata_best) | Tesseract WASM + `.traineddata` 模型 | 已实现；两种模型可切换，中英文、文本及行坐标 |
| [PaddleOCR.js](https://github.com/PaddlePaddle/PaddleOCR/tree/main/paddleocr-js) + PP-OCRv5 mobile | ONNX Runtime Web WASM + OpenCV.js | 已实现并默认使用；检测 → 裁切 → 识别，输出文字行与坐标 |

Tesseract 对清晰、正向的印刷文字更合适。复杂海报、手写、倾斜、竖排或低清晰度中文可能需要另一条 OCR 流水线。当前没有承诺自动纠正倾斜或手写识别。

## 实现

- `background.js`：注册图片右键菜单，路由到原始 frame，建立 offscreen 页面。
- `offscreen.js`：串行调度识别、加载本地 Worker / WASM / 模型，解码图片，返回统一坐标结果。最多排队四张；每个任务结束后销毁 Worker，避免模型长期占用内存。
- `ocr-result.js`：把引擎输出转换为 `{ text, lines: [{ text, x, y, width, height }], confidence }`，坐标均为 0–1。
- `paddle-worker.js`：独立 Worker 内运行 PaddleOCR，单线程 WASM 避免要求网页提供跨源隔离响应头；模型和运行库路径显式指向扩展包。任务完成或超时后销毁 Worker，释放运行库和模型内存。
- `content.js` / `geometry.js`：定位右键图片，创建 Shadow DOM 文字层和工具栏，映射尺寸、边框、padding、object-fit 和常见 object-position，跟随滚动和尺寸变化。
- `options.*`：保存本地 OCR 引擎，以及 Tesseract.js 模型、语言和版面设置。

`scripts/build-paddle.mjs` 使用 esbuild 打包 PaddleOCR，并在构建输出中将 OpenCV 4.10 的四处 embind 动态包装函数替换为普通闭包，保留参数转换、析构和返回值处理，以适配 Chrome MV3 的 CSP。不会修改 node_modules、WASM 或模型权重，不启用 `unsafe-eval`。遇到无法识别的上游代码会中止构建，防止依赖变化后静默输出不兼容版本。运行库和变更说明随扩展保留。

优先从已经加载的图片生成 canvas 快照；遇到跨域污染时，在扩展后台读取图片 URL。读取受登录态、来源防盗链、过期签名或跨域 blob 限制时，可能失败，不会绕过网站授权。快照路径可处理同源 blob 图片。图像长边最多 4096 像素、工作图最多 1000 万像素，下载最多 24 MB，推理超时为 120 秒。

文字层按行放置，行内字符位置由浏览器字体近似，不能保证每个字形像素级一致。PaddleOCR 返回的四边形当前转换为水平包围框，因此倾斜文字的覆盖层不会随文字旋转。支持普通二维布局、图片尺寸变化、contain / cover 裁切；复杂旋转、3D transform、闭合 Shadow DOM、虚拟化图片及特殊遮罩需要进一步适配。多行复制的排版取决于浏览器选区；需要完整阅读顺序时使用「复制全文」。

## 权限与隐私

`contextMenus` 用于菜单，`offscreen` 用于本地 DOM/Worker，`storage` 用于设置。`<all_urls>` 用于在网页/frame 内定位图片和读取跨域图片资源，因此 Chrome 会显示网站访问权限提示。扩展没有分析统计、遥测或云端 OCR 请求；页面本来的图片请求以及后台必要的原图读取仍会访问原图站点。模型与脚本均从扩展包加载，无远程执行代码。

## 后续 API 接入边界

本阶段只实现本地引擎，**尚未实现 API 配置或云端调用**。未来 API 适配器应返回相同的归一化结果格式，才能复用文字覆盖层。只返回纯文本的 API 无法提供准确覆盖坐标；需由接口返回文字框。API 密钥应只在扩展后台使用，不下发给网页内容脚本。

## 验证

`npm test` 覆盖 contain / cover / scale-down / fill 的几何映射、坐标归一化及空结果。`npm run check` 检查脚本语法和 MV3 清单。

`scripts/browser-smoke.mjs` 使用已有的 Playwright 和本机 Chrome，不自动下载浏览器。设置 `PLAYWRIGHT_MODULE` 为 Playwright 的 `index.mjs` 绝对路径，`BROWSER_EXECUTABLE` 为浏览器可执行文件后运行：

```powershell
node scripts/browser-smoke.mjs
```

脚本建立项目内独立测试 profile，通过 Chrome 的浏览器级调试接口加载扩展，验证真实 WASM 中英文识别、文字层缩放、鼠标拖选与快捷键复制、全文复制、断网后重跑、直接打开的图片标签页，以及跨域图片后台读取。这些检查已在本机 Chrome 155 中通过。原生右键菜单不属于页面 DOM，自动测试直接调用其消息链路；菜单点击仍需按安装说明手工检查。测试截图保存在 `output/playwright`。

双模型验证还会先运行 fast，再在同一扩展配置中切换 best，检查设置持久化、best 离线中英文识别，并将四个 IndexedDB 缓存模型的 SHA-256 与打包模型逐一比对，避免切换后仍使用旧模型。此验证证明模型切换和链路有效，不代表真实图片的识别精度已达标，实际精度需使用你的图片对比。

PaddleOCR 验证会在断网状态首次初始化引擎，检查中英文识别、归一化坐标生成的文字层和全文复制，并验证弹出菜单中的引擎切换和设置持久化；已在本机 Chrome 155 通过。`scripts/paddle-smoke.mjs` 可单独执行 Paddle Worker 的离线识别检查，使用与主脚本相同的环境变量。单元测试还比较 OpenCV 原始和 CSP 适配后的参数转换、析构、返回值、参数数量检查及方法参数指针偏移，防止构建适配改变绑定行为。
