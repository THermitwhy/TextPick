const MENU_ID = 'pic-ocr-extract';
const DEFAULTS = { language: 'chi_sim+eng', segmentation: '3', model: 'best', engine: 'paddle' };
let creating;

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: MENU_ID, title: '提取文字（本地 OCR）', contexts: ['image'] });
  });
});

async function ensureOffscreen() {
  if (creating) return creating;
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
    documentUrls: [chrome.runtime.getURL('offscreen.html')],
  });
  if (contexts.length) return;
  if (creating) return creating;
  creating = chrome.offscreen.createDocument({
    url: 'offscreen.html', reasons: ['WORKERS', 'BLOBS'],
    justification: 'Run local WebAssembly OCR workers and decode image blobs.',
  });
  try { await creating; } finally { creating = undefined; }
}

async function sendToImage(route, message) {
  // Each content script also checks jobId: results from a previous page/image are discarded.
  return chrome.tabs.sendMessage(route.tabId, { ...message, jobId: route.jobId }, { frameId: route.frameId });
}

function extractFromImage(info, tab) {
  if (info.menuItemId !== MENU_ID || !tab?.id) return;
  const route = { tabId: tab.id, frameId: info.frameId ?? 0, jobId: crypto.randomUUID() };
  return (async () => {
    const prepared = await sendToImage(route, { type: 'OCR_PREPARE', src: info.srcUrl });
    if (!prepared?.ok) throw new Error(prepared?.error || '无法定位图片，请刷新页面后重试。');
    const stored = await chrome.storage.local.get(DEFAULTS);
    const settings = {
      language: ['eng', 'chi_sim', 'chi_sim+eng'].includes(stored.language) ? stored.language : DEFAULTS.language,
      segmentation: ['3', '6', '11'].includes(stored.segmentation) ? stored.segmentation : DEFAULTS.segmentation,
      model: stored.model === 'fast' ? 'fast' : 'best',
      engine: stored.engine === 'tesseract' ? 'tesseract' : 'paddle',
    };
    await ensureOffscreen();
    const accepted = await chrome.runtime.sendMessage({
      target: 'offscreen', type: 'OCR_RUN', route, source: prepared.source, settings,
    });
    if (!accepted?.ok) throw new Error(accepted?.error || 'OCR 后台未响应。');
  })().catch(async (error) => {
    console.error('Pic OCR:', error);
    await sendToImage(route, { type: 'OCR_ERROR', error: error.message }).catch(() => {
      // Restricted Chrome pages cannot host a content script. The badge exposes this failure.
      void chrome.action.setBadgeText({ tabId: tab.id, text: '!' });
      void chrome.action.setBadgeBackgroundColor({ tabId: tab.id, color: '#b42318' });
      void chrome.action.setTitle({ tabId: tab.id, title: `无法提取：${error.message}（Chrome 内部页面不可注入）` });
    });
  });
}

chrome.contextMenus.onClicked.addListener((info, tab) => {
  void extractFromImage(info, tab);
});

chrome.runtime.onMessage.addListener((message, sender) => {
  if (sender.id !== chrome.runtime.id || sender.url !== chrome.runtime.getURL('offscreen.html')) return;
  if (message.target === 'background' && message.route) {
    void sendToImage(message.route, message.payload).catch(() => {});
  }
});
