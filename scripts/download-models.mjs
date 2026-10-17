import { mkdir, writeFile, rename, readFile } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

// Fixed upstream revision: reproducible model content, with no runtime CDN dependency.
const sources = {
  fast: { repository: 'https://github.com/tesseract-ocr/tessdata_fast', revision: '87416418657359cb625c412a48b6e1d6d41c29bd' },
  best: { repository: 'https://github.com/tesseract-ocr/tessdata_best', revision: 'e12c65a915945e4c28e237a9b52bc4a8f39a0cec' },
};
let previous;
try { previous = JSON.parse(await readFile(new URL('../models/models.lock.json', import.meta.url), 'utf8')); } catch { /* First download. */ }
const lock = { sources, files: {} };
for (const [model, { revision }] of Object.entries(sources)) {
  // Keep the original fast paths compatible with existing installations.
  const directory = model === 'fast' ? '' : 'best/';
  await mkdir(new URL(`../models/${directory}`, import.meta.url), { recursive: true });
  for (const language of ['eng', 'chi_sim']) {
    const url = `https://raw.githubusercontent.com/tesseract-ocr/tessdata_${model}/${revision}/${language}.traineddata`;
    const filename = `${directory}${language}.traineddata.gz`;
    const output = new URL(`../models/${filename}`, import.meta.url);
    const saved = previous?.files[filename];
    if (saved?.url === url) {
      try {
        const cached = await readFile(output);
        if (createHash('sha256').update(cached).digest('hex') === saved.sha256) {
          lock.files[filename] = saved;
          console.log(`Verified existing ${model}/${language}`);
          continue;
        }
      } catch { /* Missing or invalid local model: download again. */ }
    }
    console.log(`Downloading ${language} from official tessdata_${model}…`);
    const response = await fetch(url, { signal: AbortSignal.timeout(90000) });
    if (!response.ok) throw new Error(`Model download failed: HTTP ${response.status}`);
    const data = Buffer.from(await response.arrayBuffer());
    if (data.length < 100000 || data.length > 50000000) throw new Error('Unexpected model size');
    const compressed = gzipSync(data);
    await writeFile(`${fileURLToPath(output)}.tmp`, compressed);
    await rename(`${fileURLToPath(output)}.tmp`, output);
    lock.files[filename] = { url, bytes: compressed.length, sha256: createHash('sha256').update(compressed).digest('hex') };
  }
  const license = await fetch(`https://raw.githubusercontent.com/tesseract-ocr/tessdata_${model}/${revision}/LICENSE`, { signal: AbortSignal.timeout(30000) });
  if (!license.ok) throw new Error(`Failed to download ${model} model license`);
  await writeFile(new URL(`../models/${directory}LICENSE`, import.meta.url), await license.text());
}
await writeFile(new URL('../models/models.lock.json', import.meta.url), `${JSON.stringify(lock, null, 2)}\n`);
console.log('Models ready. Run npm run build.');
await import('./download-paddle-models.mjs');
