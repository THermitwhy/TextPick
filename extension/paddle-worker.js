import { PaddleOCR } from '@paddleocr/paddleocr-js';
import cv from '@techstark/opencv-js';

self.addEventListener('unhandledrejection', event => self.postMessage({ type: 'error', error: `PaddleOCR runtime: ${event.reason?.message || event.reason}` }));

// One worker per task makes timeout/cancellation also release OpenCV and ONNX memory.
self.onmessage = async ({ data: { image, assetRoot } }) => {
  let ocr;
  try {
    self.postMessage({ type: 'progress', status: '加载 PaddleOCR 本地模型与 WASM…', progress: 0.1 });
    await new Promise((resolve, reject) => {
      if (typeof cv.Mat === 'function') { resolve(); return; }
      const timer = setTimeout(() => reject(new Error('本地图片处理引擎初始化超过 20 秒，请重试')), 20000);
      cv.onAbort = reason => { clearTimeout(timer); reject(new Error(`OpenCV: ${reason}`)); };
      cv.onRuntimeInitialized = () => { clearTimeout(timer); resolve(); };
    });
    ocr = await PaddleOCR.create({
      textDetectionModelName: 'PP-OCRv5_mobile_det',
      textRecognitionModelName: 'PP-OCRv5_mobile_rec',
      textDetectionModelAsset: { url: `${assetRoot}models/paddle/PP-OCRv5_mobile_det.tar` },
      textRecognitionModelAsset: { url: `${assetRoot}models/paddle/PP-OCRv5_mobile_rec.tar` },
      worker: false,
      initialize: false,
      fetch: (...args) => {
        self.postMessage({ type: 'progress', status: '读取 PaddleOCR 本地模型…', progress: 0.25 });
        return fetch(...args);
      },
      ortOptions: { backend: 'wasm', wasmPaths: `${assetRoot}vendor/ort/`, numThreads: 1, proxy: false },
    });
    self.postMessage({ type: 'progress', status: '准备 PaddleOCR 本地识别引擎…', progress: 0.2 });
    await ocr.initialize();
    self.postMessage({ type: 'progress', status: 'PaddleOCR 正在检测并识别文字…', progress: 0.4 });
    // The SDK's direct browser ImageData adapter expects document/canvas. A cv.Mat
    // is a supported input and avoids any DOM requirement in this dedicated worker.
    const mat = cv.matFromImageData(image);
    try {
      const [result] = await ocr.predict(mat);
      self.postMessage({ type: 'result', result });
    } finally { mat.delete(); }
  } catch (error) {
    self.postMessage({ type: 'error', error: error.message || String(error) });
  } finally { await ocr?.dispose().catch(() => {}); }
};
