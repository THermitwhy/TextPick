import { normalizeResult, normalizePaddleResult } from './ocr-result.js';

const MAX_BYTES = 24 * 1024 * 1024;
let pending = 0;
let queue = Promise.resolve();

function report(route, payload) {
  void chrome.runtime.sendMessage({ target: 'background', route, payload }).catch(() => {});
}

async function loadImage(source) {
  const url = new URL(source);
  if (!['http:', 'https:', 'data:', 'file:', 'blob:'].includes(url.protocol)) throw new Error('不支持此图片地址。');
  const response = await fetch(source, { credentials: 'include', signal: AbortSignal.timeout(25000) });
  if (!response.ok) throw new Error(`读取图片失败（HTTP ${response.status}）。可尝试将图片另存后在浏览器打开。`);
  if (Number(response.headers.get('content-length')) > MAX_BYTES) throw new Error('图片超过 24 MB，请缩小图片后重试。');
  // Bound actual bytes as Content-Length may be absent or incorrect.
  const reader = response.body.getReader();
  const chunks = [];
  let bytes = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_BYTES) throw new Error('图片超过 24 MB，请缩小图片后重试。');
      chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => {}); }
  const blob = new Blob(chunks, { type: response.headers.get('content-type') || 'application/octet-stream' });
  const bitmap = await createImageBitmap(blob);
  try {
    const scale = Math.min(1, 4096 / Math.max(bitmap.width, bitmap.height), Math.sqrt(10000000 / (bitmap.width * bitmap.height)));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d', { alpha: false });
    ctx.fillStyle = 'white';
    ctx.fillRect(0, 0, width, height);
    ctx.drawImage(bitmap, 0, 0, width, height);
    return { image: canvas, width, height };
  } finally { bitmap.close(); }
}

async function run({ route, source, settings }) {
  const engine = settings.engine === 'tesseract' ? 'tesseract' : 'paddle';
  const model = settings.model === 'fast' ? 'fast' : 'best';
  const label = engine === 'paddle' ? 'PaddleOCR · PP-OCRv5 mobile' : `tessdata_${model}`;
  let worker;
  let timer;
  let timedOut = false;
  try {
    report(route, { type: 'OCR_PROGRESS', status: '正在读取图片…', progress: 0 });
    const { image, width, height } = await loadImage(source);
    // A fresh worker bounds memory lifetime and allows language changes without stale state.
    const task = (async () => {
      if (engine === 'paddle') {
        const imageData = image.getContext('2d').getImageData(0, 0, width, height);
        const paddleWorker = new Worker(chrome.runtime.getURL('paddle-worker.js'), { type: 'module' });
        worker = { terminate: async () => paddleWorker.terminate() };
        return new Promise((resolve, reject) => {
          paddleWorker.onerror = event => reject(new Error(event.message || 'PaddleOCR Worker 加载失败'));
          paddleWorker.onmessage = ({ data }) => {
            if (data.type === 'progress') report(route, { type: 'OCR_PROGRESS', status: data.status, progress: data.progress });
            else if (data.type === 'error') reject(new Error(data.error));
            else if (data.type === 'result') resolve(normalizePaddleResult(data.result, width, height));
          };
          paddleWorker.postMessage({ image: imageData, assetRoot: chrome.runtime.getURL('') }, [imageData.data.buffer]);
        });
      }
      worker = await Tesseract.createWorker(settings.language, 1, {
        workerPath: chrome.runtime.getURL('vendor/worker.min.js'),
        corePath: chrome.runtime.getURL('vendor/core'),
        langPath: chrome.runtime.getURL(model === 'fast' ? 'models' : 'models/best'),
        // Tesseract caches by language, not langPath. Separate keys prevent silently reusing fast as best.
        cachePath: `pic-ocr-${model}-v1`,
        workerBlobURL: false,
        logger: ({ status, progress }) => report(route, { type: 'OCR_PROGRESS', status, progress }),
      });
      if (timedOut) {
        await worker.terminate();
        throw new Error('识别已超时');
      }
      await worker.setParameters({ tessedit_pageseg_mode: settings.segmentation, preserve_interword_spaces: '1' });
      const { data } = await worker.recognize(image, {}, { text: true, blocks: true });
      return normalizeResult(data, width, height);
    })();
    const result = await Promise.race([task, new Promise((_, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        reject(new Error('识别超过 120 秒，请缩小图片后重试。'));
      }, 120000);
    })]);
    report(route, { type: 'OCR_RESULT', result: { ...result, model, engine, label } });
  } catch (error) {
    report(route, { type: 'OCR_ERROR', error: `${label}：${error.message || error}；请确认扩展内已打包所选模型及运行库。` });
  } finally {
    clearTimeout(timer);
    if (worker) await worker.terminate().catch(() => {});
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id || message.target !== 'offscreen' || message.type !== 'OCR_RUN') return;
  if (pending >= 4) { sendResponse({ ok: false, error: '最多同时排队 4 张图片，请稍候。' }); return; }
  pending++;
  report(message.route, { type: 'OCR_PROGRESS', status: '已加入本地识别队列…', progress: 0 });
  queue = queue.then(() => run(message)).catch(console.error).finally(() => pending--);
  sendResponse({ ok: true });
});
