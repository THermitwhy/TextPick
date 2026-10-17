// Run with an installed Playwright module and a Chromium-compatible executable.
// No browser download or test framework is needed. Uses an isolated profile.
import { createServer } from 'node:http';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
const { chromium } = await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE));
const output = resolve('output/playwright');
await mkdir(output, { recursive: true });
const extensionPath = resolve('dist');
let fixture;
const server = createServer((req, res) => {
  if (req.url === '/image.png') { res.setHeader('Content-Type', 'image/png'); res.end(fixture); return; }
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.end('<!doctype html><html><head><title>OCR fixture</title></head><body style="margin:48px;background:#e9ece8;font-family:Arial"><h1>图片文字选择验证</h1><img id="sample" src="/image.png" style="width:720px;height:300px;object-fit:contain;background:#ddd;border:4px solid white"><div style="height:1200px"></div></body></html>');
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const crossServer = createServer((_req, res) => { res.setHeader('Content-Type', 'image/png'); res.end(fixture); });
await new Promise(resolve => crossServer.listen(0, '127.0.0.1', resolve));
const crossOrigin = `http://127.0.0.1:${crossServer.address().port}`;
let context;
async function startOcr(worker, origin, tabId) {
  // Native context menus are outside Playwright's page DOM. Exercise their message pipeline.
  return worker.evaluate(async ({ origin, tabId }) => {
    const route = { tabId, frameId: 0, jobId: crypto.randomUUID() };
    const prepared = await chrome.tabs.sendMessage(tabId, {
      type: 'OCR_PREPARE', jobId: route.jobId, src: `${origin}/image.png`,
    }, { frameId: 0 });
    if (!prepared?.ok) throw new Error(prepared?.error || 'Prepare failed');
    const contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
    if (!contexts.length) await chrome.offscreen.createDocument({
      url: 'offscreen.html', reasons: ['WORKERS', 'BLOBS'], justification: 'Local OCR browser smoke test',
    });
    const settings = await chrome.storage.local.get({ language: 'chi_sim+eng', segmentation: '3', model: 'best', engine: 'paddle' });
    const response = await chrome.runtime.sendMessage({ target: 'offscreen', type: 'OCR_RUN', route, source: prepared.source, settings });
    if (!response?.ok) throw new Error(response?.error || 'Run failed');
    return prepared.source.startsWith('http');
  }, { origin, tabId });
}
try {
  context = await chromium.launchPersistentContext(resolve(output, 'profile'), {
    executablePath: process.env.BROWSER_EXECUTABLE,
    headless: true,
    ignoreDefaultArgs: ['--disable-extensions'],
    viewport: { width: 1100, height: 900 },
    args: ['--enable-unsafe-extension-debugging'],
  });
  const page = await context.newPage();
  const cdp = await context.browser().newBrowserCDPSession();
  await cdp.send('Extensions.loadUnpacked', { path: extensionPath });
  fixture = Buffer.from(await page.evaluate(() => {
    const canvas = document.createElement('canvas'); canvas.width = 1200; canvas.height = 420;
    const ctx = canvas.getContext('2d'); ctx.fillStyle = 'white'; ctx.fillRect(0, 0, 1200, 420);
    ctx.fillStyle = '#111'; ctx.font = 'bold 64px Arial'; ctx.fillText('LOCAL OCR TEST 2026', 65, 130);
    ctx.font = '58px "Microsoft YaHei"'; ctx.fillText('本地文字识别 测试图片', 65, 260);
    ctx.font = '36px Arial'; ctx.fillText('Select text and copy from this image.', 65, 350);
    return canvas.toDataURL('image/png').split(',')[1];
  }), 'base64');
  await writeFile(resolve(output, 'fixture.png'), fixture);
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker', { timeout: 20000 });
  const extensionOrigin = worker.url().split('/').slice(0, 3).join('/');
  const errors = [];
  context.on('weberror', error => { errors.push(error.error().message); console.error('Browser error:', error.error().message); });
  const settings = await context.newPage();
  await settings.goto(`${extensionOrigin}/options.html`);
  await settings.locator('#engine').selectOption('tesseract');
  await settings.locator('#model').selectOption('fast');
  await settings.locator('#segmentation').selectOption('6');
  await settings.getByRole('button', { name: '保存设置' }).click();
  await settings.reload();
  assert.equal(await settings.locator('#model').inputValue(), 'fast');
  await settings.screenshot({ path: resolve(output, 'settings.png'), fullPage: true });
  await page.goto(origin);
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin });
  await page.locator('#sample').click({ button: 'right' });
  await page.keyboard.press('Escape');
  const tabId = await worker.evaluate(async origin => (await chrome.tabs.query({})).find(tab => tab.url?.startsWith(origin)).id, origin);
  await startOcr(worker, origin, tabId);
  const textarea = page.locator('textarea[aria-label="识别结果"]');
  await page.waitForFunction(() => {
    const host = [...document.documentElement.children].find(node => node.shadowRoot?.querySelector('.status'));
    const status = host?.shadowRoot.querySelector('.status').textContent;
    return status?.includes('已提取') || status?.includes('请确认');
  }, null, { timeout: 150000 });
  console.log('Status:', await page.locator('.status').textContent());
  await page.screenshot({ path: resolve(output, 'recognition.png') });
  const text = await textarea.inputValue();
  assert.match(await page.locator('.status').textContent(), /tessdata_fast/);
  console.log('Recognized:', text);
  assert.match(text, /LOCAL OCR TEST 2026/);
  assert.match(text.replaceAll(' ', ''), /本地文字识别/);
  await page.getByText('查看 / 编辑提取结果').click();
  await page.getByRole('button', { name: '显示文字', exact: true }).click();
  const lines = page.locator('.line');
  assert.ok(await lines.count() >= 3);
  const before = await lines.first().boundingBox();
  await page.screenshot({ path: resolve(output, 'overlay.png') });
  await page.evaluate(() => { document.querySelector('#sample').style.width = '500px'; });
  await page.waitForTimeout(150);
  const after = await lines.first().boundingBox();
  assert.ok(after.width < before.width);
  // Verify a real drag selection and keyboard copy, rather than just constructing a DOM Range.
  const target = await lines.first().boundingBox();
  await page.mouse.move(target.x + 1, target.y + target.height / 2);
  await page.mouse.down();
  await page.mouse.move(target.x + target.width - 1, target.y + target.height / 2, { steps: 15 });
  await page.mouse.up();
  await page.keyboard.press('ControlOrMeta+C');
  assert.match(await page.evaluate(() => navigator.clipboard.readText()), /OCR TEST/);
  await page.getByRole('button', { name: '复制全文', exact: true }).click();
  await page.getByRole('button', { name: '已复制', exact: true }).waitFor();
  assert.match((await page.evaluate(() => navigator.clipboard.readText())).replaceAll(' ', ''), /本地文字识别/);
  // Re-run offline to verify the local language files and packaged WASM are sufficient.
  await context.setOffline(true);
  await startOcr(worker, origin, tabId);
  await page.waitForFunction(() => {
    const host = [...document.documentElement.children].find(node => node.shadowRoot?.querySelector('.status'));
    return host?.shadowRoot.querySelector('.status').textContent.includes('已提取');
  }, null, { timeout: 150000 });
  assert.match(await textarea.inputValue(), /LOCAL OCR TEST 2026/);
  console.log('Offline re-run passed.');
  await context.setOffline(false);
  // Raw image tabs are a main usage scenario, and have a browser-generated <img> document.
  await page.goto(`${origin}/image.png`);
  await page.locator('img').click({ button: 'right', position: { x: 20, y: 20 } });
  await page.keyboard.press('Escape');
  await startOcr(worker, origin, tabId);
  await page.waitForFunction(() => [...document.documentElement.children].some(node =>
    node.shadowRoot?.querySelector('.status')?.textContent.includes('已提取')), null, { timeout: 150000 });
  assert.match(await textarea.inputValue(), /LOCAL OCR TEST 2026/);
  console.log('Raw image tab passed.');
  await page.goto(origin);
  await page.locator('#sample').evaluate((image, source) => { image.src = source; }, `${crossOrigin}/image.png`);
  await page.locator('#sample').click({ button: 'right' });
  await page.keyboard.press('Escape');
  assert.equal(await startOcr(worker, crossOrigin, tabId), true, 'Cross-origin image should use extension fetch fallback');
  await page.waitForFunction(() => [...document.documentElement.children].some(node =>
    node.shadowRoot?.querySelector('.status')?.textContent.includes('已提取')), null, { timeout: 150000 });
  assert.match(await textarea.inputValue(), /LOCAL OCR TEST 2026/);
  // Switch to best in the same extension profile, then test offline with a warm fast cache.
  // Comparing cache bytes with the actual model files proves the two model sets are not mixed.
  await settings.locator('#model').selectOption('best');
  await settings.getByRole('button', { name: '保存设置' }).click();
  await settings.reload();
  assert.equal(await settings.locator('#model').inputValue(), 'best');
  await settings.screenshot({ path: resolve(output, 'settings-best.png'), fullPage: true });
  await page.goto(origin);
  await page.locator('#sample').click({ button: 'right' });
  await page.keyboard.press('Escape');
  await context.setOffline(true);
  await startOcr(worker, origin, tabId);
  await page.waitForFunction(() => [...document.documentElement.children].some(node =>
    node.shadowRoot?.querySelector('.status')?.textContent.includes('已提取')), null, { timeout: 150000 });
  assert.match(await page.locator('.status').textContent(), /tessdata_best/);
  assert.match(await textarea.inputValue(), /LOCAL OCR TEST 2026/);
  assert.match((await textarea.inputValue()).replaceAll(' ', ''), /本地文字识别/);
  await page.screenshot({ path: resolve(output, 'best-result.png') });
  const hashes = await settings.evaluate(async () => {
    const database = await new Promise((resolve, reject) => {
      const request = indexedDB.open('keyval-store');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const hashes = {};
    try {
      for (const model of ['fast', 'best']) for (const language of ['eng', 'chi_sim']) {
        const key = `pic-ocr-${model}-v1/${language}.traineddata`;
        const data = await new Promise((resolve, reject) => {
          const request = database.transaction('keyval').objectStore('keyval').get(key);
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        });
        if (!data) throw new Error(`Missing model cache: ${key}`);
        hashes[`${model}/${language}`] = [...new Uint8Array(await crypto.subtle.digest('SHA-256', data))].map(n => n.toString(16).padStart(2, '0')).join('');
      }
    } finally { database.close(); }
    return hashes;
  });
  for (const model of ['fast', 'best']) for (const language of ['eng', 'chi_sim']) {
    const data = gunzipSync(await readFile(resolve('models', model === 'best' ? 'best' : '', `${language}.traineddata.gz`)));
    assert.equal(hashes[`${model}/${language}`], createHash('sha256').update(data).digest('hex'));
  }
  console.log('Best/fast switching, persisted setting, offline best OCR and separate model cache hashes passed.');
  await settings.locator('#engine').selectOption('paddle');
  await settings.getByRole('button', { name: '保存设置' }).click();
  await settings.reload();
  assert.equal(await settings.locator('#engine').inputValue(), 'paddle');
  assert.equal(await settings.locator('#tesseract-settings').isVisible(), false);
  await settings.screenshot({ path: resolve(output, 'settings-paddle.png'), fullPage: true });
  // Cold Paddle initialization while offline proves both models and all runtime assets are local.
  await startOcr(worker, origin, tabId);
  await page.waitForFunction(() => [...document.documentElement.children].some(node => {
    const text = node.shadowRoot?.querySelector('.status')?.textContent;
    return text?.includes('已提取') || text?.includes('请确认');
  }), null, { timeout: 150000 });
  console.log('Paddle status:', await page.locator('.status').textContent());
  console.log('Paddle text:', await textarea.inputValue());
  await page.screenshot({ path: resolve(output, 'paddle-result.png') });
  assert.match(await page.locator('.status').textContent(), /已提取.*PaddleOCR/);
  assert.match(await textarea.inputValue(), /LOCAL OCR TEST 2026/);
  assert.match((await textarea.inputValue()).replaceAll(' ', ''), /本地文字识别/);
  assert.ok(await page.locator('.line').count() >= 3);
  await page.getByRole('button', { name: '复制全文', exact: true }).click();
  assert.match((await page.evaluate(() => navigator.clipboard.readText())).replaceAll(' ', ''), /本地文字识别/);
  console.log('PaddleOCR cold offline initialization, bilingual OCR, overlay and copy passed.');
  assert.deepEqual(errors, []);
  console.log('Browser smoke passed: MV3, bilingual OCR, overlay resizing, drag/keyboard copy, full copy, offline re-run, raw image tab, cross-origin fetch.');
} finally {
  await context?.close();
  await new Promise(resolve => server.close(resolve));
  await new Promise(resolve => crossServer.close(resolve));
}
