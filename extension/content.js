(() => {
  if (globalThis.__picOcrInstalled) return;
  globalThis.__picOcrInstalled = true;
  let lastImage;
  let active;
  const MAX_PIXELS = 10000000;
  const labels = {
    'loading tesseract core': '加载 WASM 引擎',
    'initializing tesseract': '初始化引擎',
    'loading language traineddata': '加载本地语言模型',
    'initializing api': '准备识别',
    'recognizing text': '正在识别文字',
  };

  document.addEventListener('contextmenu', event => {
    // composedPath locates images in open shadow trees as well as ordinary <picture>/<img>.
    const image = event.composedPath().find(node => node instanceof HTMLImageElement);
    if (image) lastImage = image;
  }, true);

  function matches(image, src) {
    return image?.isConnected && (image.currentSrc === src || image.src === src);
  }

  function close() {
    if (!active) return;
    cancelAnimationFrame(active.frame);
    active.host.remove();
    active = undefined;
  }

  function makeButton(text, callback) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = text;
    button.addEventListener('click', callback);
    return button;
  }

  function notifyError(message) {
    const host = document.createElement('div');
    host.style.cssText = 'position:fixed!important;right:20px!important;top:20px!important;z-index:2147483647!important;';
    const root = host.attachShadow({ mode: 'open' });
    const box = document.createElement('div');
    box.style.cssText = 'max-width:360px;padding:16px;border-radius:10px;background:#101c2e;color:#fff;font:14px/1.6 system-ui;box-shadow:0 8px 32px #0005;';
    box.setAttribute('role', 'alert');
    box.textContent = `拾字：${message}`;
    const dismiss = makeButton('关闭', () => host.remove());
    dismiss.style.cssText = 'display:block;margin-top:10px;cursor:pointer;';
    box.append(dismiss); root.append(box); document.documentElement.append(host);
    setTimeout(() => host.remove(), 12000);
  }

  async function copyText(state, button) {
    const text = state.textarea.value;
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      button.textContent = '已复制';
    } catch {
      // HTTP pages may not expose Clipboard API. Native textarea copy is a user-click fallback.
      state.details.open = true;
      state.textarea.focus();
      state.textarea.select();
      button.textContent = document.execCommand('copy') ? '已复制' : '请按 Ctrl/Cmd+C';
    }
    setTimeout(() => { button.textContent = '复制全文'; }, 1800);
  }

  function createLayer(image, jobId) {
    close();
    const host = document.createElement('div');
    host.style.cssText = 'all:initial!important;position:fixed!important;inset:0!important;z-index:2147483647!important;pointer-events:none!important;';
    const root = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = `
      :host { font:14px/1.5 system-ui,sans-serif; color:#e8eef8; color-scheme:dark; }
      * { box-sizing:border-box; }
      .clip { position:fixed; overflow:hidden; pointer-events:none; }
      .surface { position:absolute; pointer-events:none; }
      .line { position:absolute; display:block; white-space:pre; line-height:1; color:transparent;
        cursor:text; user-select:text; -webkit-user-select:text; pointer-events:auto;
        transform-origin:top left; font-family:Arial,'Microsoft YaHei',sans-serif; }
      .line::selection { color:transparent; background:rgba(64,146,255,.48); }
      .visible .line { color:#12233b; background:rgba(255,255,255,.94); }
      .visible .line::selection { color:white; background:#1969d4; }
      .line:hover { outline:1px solid #5aa5ff; }
      .panel { position:fixed; width:min(420px,calc(100vw - 24px)); padding:14px; border:1px solid #344761;
        border-radius:14px; background:#101c2ef5; box-shadow:0 12px 48px #0005; pointer-events:auto; }
      .header { display:flex; align-items:center; gap:8px; margin-bottom:8px; }
      strong { font-size:15px; color:#fff; } .tag { font-size:11px; color:#80e5b9; margin-right:auto; }
      .status { margin:8px 0; color:#bcd0e7; font-size:12px; overflow-wrap:anywhere; }
      progress { width:100%; height:5px; accent-color:#6bb4ff; }
      .actions { display:flex; flex-wrap:wrap; gap:6px; }
      button { font:inherit; font-size:12px; padding:6px 10px; border:1px solid #3b516e; border-radius:7px;
        color:#edf6ff; background:#233853; cursor:pointer; } button:hover { background:#36567d; }
      button:disabled { opacity:.4; cursor:default; } .close { padding:1px 7px; font-size:19px; }
      details { margin-top:10px; font-size:12px; } summary { cursor:pointer; color:#a9bfd9; }
      textarea { width:100%; height:150px; resize:vertical; margin-top:8px; padding:8px; border:1px solid #415676;
        border-radius:6px; background:#0b1524; color:#eef5ff; font:13px/1.6 system-ui; user-select:text; }
      [hidden] { display:none!important; }
    `;
    const clip = document.createElement('div'); clip.className = 'clip';
    const surface = document.createElement('div'); surface.className = 'surface'; clip.append(surface);
    const panel = document.createElement('section'); panel.className = 'panel'; panel.setAttribute('aria-label', '图片 OCR');
    const header = document.createElement('div'); header.className = 'header';
    const title = document.createElement('strong'); title.textContent = '拾字';
    const tag = document.createElement('span'); tag.className = 'tag'; tag.textContent = 'LOCAL OCR';
    const dismiss = makeButton('×', close); dismiss.className = 'close'; dismiss.setAttribute('aria-label', '关闭文字层');
    header.append(title, tag, dismiss);
    const status = document.createElement('p'); status.className = 'status'; status.setAttribute('role', 'status'); status.textContent = '准备本地识别…';
    const progress = document.createElement('progress'); progress.max = 1; progress.value = 0; progress.setAttribute('aria-label', '识别进度');
    const actions = document.createElement('div'); actions.className = 'actions';
    const details = document.createElement('details');
    const summary = document.createElement('summary'); summary.textContent = '查看 / 编辑提取结果';
    const textarea = document.createElement('textarea'); textarea.setAttribute('aria-label', '识别结果'); textarea.spellcheck = false;
    details.append(summary, textarea); details.hidden = true;
    const state = { image, src: image.currentSrc || image.src, jobId, host, surface, panel, clip, status, progress, details, textarea, nodes: [] };
    const copy = makeButton('复制全文', () => void copyText(state, copy)); copy.disabled = true;
    const toggle = makeButton('显示文字', () => {
      const visible = surface.classList.toggle('visible'); toggle.textContent = visible ? '隐藏文字' : '显示文字';
    }); toggle.disabled = true;
    actions.append(copy, toggle); state.copy = copy; state.toggle = toggle;
    panel.append(header, status, progress, actions, details);
    root.append(style, clip, panel);
    document.documentElement.append(host);
    active = state;

    const update = () => {
      if (active !== state) return;
      if (!image.isConnected || (image.currentSrc || image.src) !== state.src) { close(); return; }
      const rect = image.getBoundingClientRect();
      const css = getComputedStyle(image);
      const px = name => parseFloat(css[name]) || 0;
      // getBoundingClientRect includes borders/padding. object-fit uses the content box.
      const sx = image.offsetWidth ? rect.width / image.offsetWidth : 1;
      const sy = image.offsetHeight ? rect.height / image.offsetHeight : 1;
      const leftInset = (px('borderLeftWidth') + px('paddingLeft')) * sx;
      const topInset = (px('borderTopWidth') + px('paddingTop')) * sy;
      const box = { left: rect.left + leftInset, top: rect.top + topInset,
        width: rect.width - leftInset - (px('borderRightWidth') + px('paddingRight')) * sx,
        height: rect.height - topInset - (px('borderBottomWidth') + px('paddingBottom')) * sy };
      const mapped = PicOcrGeometry.imageRect(box, image.naturalWidth || 1, image.naturalHeight || 1, css.objectFit, css.objectPosition);
      let left = Math.max(0, box.left), top = Math.max(0, box.top);
      let right = Math.min(innerWidth, box.left + box.width), bottom = Math.min(innerHeight, box.top + box.height);
      for (let parent = image.parentElement; parent; parent = parent.parentElement) {
        const pcss = getComputedStyle(parent);
        if (/(hidden|clip|scroll|auto)/.test(pcss.overflowX + pcss.overflowY)) {
          const p = parent.getBoundingClientRect();
          if (/(hidden|clip|scroll|auto)/.test(pcss.overflowX)) { left = Math.max(left, p.left); right = Math.min(right, p.right); }
          if (/(hidden|clip|scroll|auto)/.test(pcss.overflowY)) { top = Math.max(top, p.top); bottom = Math.min(bottom, p.bottom); }
        }
      }
      const signature = [left, top, right, bottom, mapped.left, mapped.top, mapped.width, mapped.height, innerWidth, innerHeight, css.visibility, css.display].join(',');
      if (signature !== state.signature) {
        state.signature = signature;
        clip.style.cssText = `left:${left}px;top:${top}px;width:${Math.max(0, right-left)}px;height:${Math.max(0,bottom-top)}px;visibility:${css.visibility};`;
        surface.style.cssText = `left:${mapped.left-left}px;top:${mapped.top-top}px;width:${mapped.width}px;height:${mapped.height}px;`;
        for (const { element, line, measured } of state.nodes) {
          const size = Math.max(1, line.height * mapped.height);
          element.style.cssText = `left:${line.x*100}%;top:${line.y*100}%;font-size:${size}px;transform:scaleX(${line.width*mapped.width/(measured*size || 1)});`;
        }
        panel.style.left = `${Math.max(12, Math.min(innerWidth - Math.min(420, innerWidth - 24) - 12, rect.left))}px`;
      }
      const panelHeight = panel.getBoundingClientRect().height;
      panel.style.top = `${Math.max(12, Math.min(innerHeight - panelHeight - 12, rect.bottom + 10))}px`;
      state.frame = requestAnimationFrame(update);
    };
    update();
    return state;
  }

  function capture(image) {
    // Canvas preserves blob URLs and already-loaded same-origin images. Cross-origin taint falls back to extension fetch.
    const scale = Math.min(1, 4096 / Math.max(image.naturalWidth, image.naturalHeight), Math.sqrt(MAX_PIXELS / (image.naturalWidth * image.naturalHeight)));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
    canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/png');
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (sender.id !== chrome.runtime.id) return;
    if (message.type === 'OCR_PREPARE') {
      const image = matches(lastImage, message.src) ? lastImage : [...document.images].find(img => matches(img, message.src));
      if (!image || !image.complete || !image.naturalWidth) {
        const error = '图片尚未加载或已消失，请等待加载后重新右键。';
        notifyError(error);
        sendResponse({ ok: false, error }); return;
      }
      createLayer(image, message.jobId);
      let source = message.src;
      try { source = capture(image); } catch { /* Extension host permissions allow fetching most CORS-protected images. */ }
      sendResponse({ ok: true, source });
      return;
    }
    if (!active || active.jobId !== message.jobId) return;
    if (message.type === 'OCR_PROGRESS') {
      const percent = Math.round(Math.max(0, Math.min(1, message.progress || 0)) * 100);
      active.status.textContent = `${labels[message.status] || message.status} ${percent}%`;
      active.progress.value = percent / 100;
    } else if (message.type === 'OCR_ERROR') {
      active.status.textContent = message.error;
      active.progress.hidden = true;
    } else if (message.type === 'OCR_RESULT') {
      const { result } = message;
      active.progress.hidden = true;
      active.textarea.value = result.text;
      active.copy.disabled = !result.text;
      active.toggle.disabled = !result.lines.length;
      active.details.hidden = !result.text;
      active.status.textContent = result.text ? `已提取 ${result.lines.length} 行 · ${result.label} · 拖选后按 Ctrl/Cmd+C 复制` : `${result.label} 未发现文字；可在扩展菜单中切换引擎后重试。`;
      const ctx = document.createElement('canvas').getContext('2d');
      ctx.font = "100px Arial,'Microsoft YaHei',sans-serif";
      for (const line of result.lines) {
        const element = document.createElement('span'); element.className = 'line'; element.textContent = line.text;
        active.surface.append(element, document.createTextNode('\n'));
        active.nodes.push({ element, line, measured: ctx.measureText(line.text).width / 100 });
      }
      active.signature = undefined;
    }
  });
})();
