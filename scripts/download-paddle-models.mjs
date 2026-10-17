import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
const directory = new URL('../models/paddle/', import.meta.url);
await mkdir(directory, { recursive: true });
let previous;
try { previous = JSON.parse(await readFile(new URL('models.lock.json', directory), 'utf8')); } catch { /* First install. */ }
const lock = { sdk: '@paddleocr/paddleocr-js@0.4.2', files: {} };
for (const stage of ['det', 'rec']) {
  const name = `PP-OCRv5_mobile_${stage}.tar`;
  // Official assets listed by the pinned PaddleOCR.js SDK; weights/config/dictionary stay together.
  const url = `https://paddle-model-ecology.bj.bcebos.com/paddlex/official_inference_model/paddle3.0.0/PP-OCRv5_mobile_${stage}_onnx_infer.tar`;
  const output = new URL(name, directory);
  const saved = previous?.files[name];
  if (saved?.url === url) {
    try {
      const bytes = await readFile(output);
      if (createHash('sha256').update(bytes).digest('hex') === saved.sha256) {
        lock.files[name] = saved;
        console.log(`Verified existing PaddleOCR ${stage}`);
        continue;
      }
    } catch { /* Download again if missing. */ }
  }
  console.log(`Downloading official PaddleOCR ${stage} model…`);
  const response = await fetch(url, { signal: AbortSignal.timeout(120000) });
  if (!response.ok) throw new Error(`Paddle model download: HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length < 100000 || bytes.length > 80000000 || bytes.subarray(257, 262).toString() !== 'ustar') throw new Error('Unexpected PaddleOCR tar model format');
  await writeFile(`${fileURLToPath(output)}.tmp`, bytes);
  await rename(`${fileURLToPath(output)}.tmp`, output);
  lock.files[name] = { url, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
}
await writeFile(new URL('models.lock.json', directory), `${JSON.stringify(lock, null, 2)}\n`);
for (const [name, url] of [
  ['LICENSE', 'https://raw.githubusercontent.com/PaddlePaddle/PaddleOCR/main/LICENSE'],
  ['ONNX-Runtime-LICENSE', 'https://raw.githubusercontent.com/microsoft/onnxruntime/main/LICENSE'],
]) {
  try { await readFile(new URL(name, directory)); continue; } catch { /* Download upstream notices once. */ }
  const response = await fetch(url, { signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new Error(`License download failed: ${name}`);
  await writeFile(new URL(name, directory), await response.text());
}
console.log('PaddleOCR models ready.');
