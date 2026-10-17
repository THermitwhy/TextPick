import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { mkdir } from 'node:fs/promises';
import assert from 'node:assert/strict';
const { chromium } = await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE));
await mkdir('output/playwright', { recursive: true });
const context = await chromium.launchPersistentContext(resolve('output/playwright/paddle-profile'), {
  executablePath: process.env.BROWSER_EXECUTABLE, headless: true,
  ignoreDefaultArgs: ['--disable-extensions'], args: ['--enable-unsafe-extension-debugging'],
});
context.on('console', message => console.log('Browser:', message.type(), message.text()));
try {
  const cdp = await context.browser().newBrowserCDPSession();
  const { id } = await cdp.send('Extensions.loadUnpacked', { path: resolve('dist') });
  const page = await context.newPage();
  await page.goto(`chrome-extension://${id}/options.html`);
  await context.setOffline(true);
  const result = await page.evaluate(async () => {
    const canvas = document.createElement('canvas'); canvas.width = 1200; canvas.height = 420;
    const ctx = canvas.getContext('2d'); ctx.fillStyle = 'white'; ctx.fillRect(0,0,1200,420);
    ctx.fillStyle = 'black'; ctx.font = 'bold 64px Arial'; ctx.fillText('LOCAL OCR TEST 2026',65,130);
    ctx.font = '58px "Microsoft YaHei"'; ctx.fillText('本地文字识别 测试图片',65,260);
    const image = ctx.getImageData(0,0,1200,420);
    const worker = new Worker(chrome.runtime.getURL('paddle-worker.js'), { type: 'module' });
    try {
      return await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Paddle timeout')), 45000);
        worker.onerror = event => { clearTimeout(timer); reject(new Error(event.message)); };
        worker.onmessage = ({ data }) => {
          console.log('Paddle:', JSON.stringify(data.type === 'result' ? { type: data.type } : data));
          if (data.type === 'result') { clearTimeout(timer); resolve(data.result); }
          if (data.type === 'error') { clearTimeout(timer); reject(new Error(data.error)); }
        };
        worker.postMessage({ image, assetRoot: chrome.runtime.getURL('') }, [image.data.buffer]);
      });
    } finally { worker.terminate(); }
  });
  const text = result.items.map(item => item.text).join('\n');
  console.log(text);
  assert.match(text, /LOCAL OCR TEST 2026/);
  assert.match(text.replaceAll(' ', ''), /本地文字识别/);
  console.log('Paddle worker offline smoke passed.');
} finally { await context.close(); }
