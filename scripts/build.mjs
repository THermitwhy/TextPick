import { cp, mkdir, readdir, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { buildPaddle } from './build-paddle.mjs';
const project = fileURLToPath(new URL('../', import.meta.url));
const at = path => join(project, path);
let lock;
try { lock = JSON.parse(await readFile(at('models/models.lock.json'), 'utf8')); }
catch { throw new Error('缺少本地模型。请先运行 node --use-env-proxy scripts/download-models.mjs（或手动按 README 安装模型）。'); }
for (const name of ['eng.traineddata.gz', 'chi_sim.traineddata.gz', 'best/eng.traineddata.gz', 'best/chi_sim.traineddata.gz']) {
  const data = await readFile(at(`models/${name}`));
  const expected = lock.files[name]?.sha256;
  if (!expected || createHash('sha256').update(data).digest('hex') !== expected) throw new Error(`模型校验失败：${name}`);
}
await mkdir(at('dist/vendor/core'), { recursive: true });
await cp(at('extension'), at('dist'), { recursive: true });
for (const name of ['tesseract.min.js', 'worker.min.js', 'tesseract.min.js.LICENSE.txt', 'worker.min.js.LICENSE.txt']) {
  await cp(at(`node_modules/tesseract.js/dist/${name}`), at(`dist/vendor/${name}`));
}
for (const name of await readdir(at('node_modules/tesseract.js-core'))) {
  if (/^tesseract-core.*\.(wasm|js)$/.test(name)) await cp(at(`node_modules/tesseract.js-core/${name}`), at(`dist/vendor/core/${name}`));
}
await mkdir(at('dist/licenses'), { recursive: true });
await cp(at('node_modules/tesseract.js/LICENSE.md'), at('dist/licenses/tesseract.js-LICENSE.md'));
await cp(at('node_modules/tesseract.js-core/LICENSE'), at('dist/licenses/tesseract.js-core-LICENSE'));
await cp(at('models'), at('dist/models'), { recursive: true, filter: source => !source.endsWith('.tmp') });
await buildPaddle();
console.log(`可加载扩展目录：${at('dist')}`);
