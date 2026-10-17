import { readdir, readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root = new URL('../', import.meta.url);
for (const directory of ['extension', 'scripts', 'tests']) {
  for (const name of await readdir(new URL(`${directory}/`, root))) {
    if (!/\.(mjs|js)$/.test(name)) continue;
    const result = spawnSync(process.execPath, ['--check', fileURLToPath(new URL(`${directory}/${name}`, root))], { encoding: 'utf8' });
    if (result.status !== 0) throw new Error(`${name}: ${result.stderr}`);
  }
}
const manifest = JSON.parse(await readFile(new URL('extension/manifest.json', root)));
if (manifest.manifest_version !== 3) throw new Error('Expected MV3');
console.log('JavaScript syntax and manifest OK.');
