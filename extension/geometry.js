/* Shared by the content script and coordinate tests. All coordinates are CSS pixels. */
globalThis.PicOcrGeometry = {
  imageRect(box, naturalWidth, naturalHeight, fit = 'fill', position = '50% 50%') {
    let width = box.width;
    let height = box.height;
    const contain = Math.min(width / naturalWidth, height / naturalHeight);
    const cover = Math.max(width / naturalWidth, height / naturalHeight);
    if (fit !== 'fill') {
      const scale = fit === 'cover' ? cover : fit === 'none' ? 1 : fit === 'scale-down' ? Math.min(1, contain) : contain;
      width = naturalWidth * scale;
      height = naturalHeight * scale;
    }
    const parts = position.trim().split(/\s+/);
    const offset = (value, free) => {
      if (value === 'left' || value === 'top') return 0;
      if (value === 'right' || value === 'bottom') return free;
      if (value === 'center') return free / 2;
      return value?.endsWith('%') ? free * parseFloat(value) / 100 : parseFloat(value) || 0;
    };
    return { left: box.left + offset(parts[0], box.width - width), top: box.top + offset(parts[1] ?? '50%', box.height - height), width, height };
  },
};
