/** Normalize engine-specific coordinates to fractions of the decoded working image. */
export function normalizeResult(data, width, height) {
  const lines = [];
  for (const block of data.blocks ?? []) {
    for (const paragraph of block.paragraphs ?? []) {
      for (const line of paragraph.lines ?? []) {
        const text = (line.text || (line.words ?? []).map(w => w.text).join(' ')).trim();
        const b = line.bbox;
        if (!text || !b || ![b.x0, b.y0, b.x1, b.y1].every(Number.isFinite)) continue;
        const x0 = Math.max(0, Math.min(1, b.x0 / width));
        const y0 = Math.max(0, Math.min(1, b.y0 / height));
        const x1 = Math.max(x0, Math.min(1, b.x1 / width));
        const y1 = Math.max(y0, Math.min(1, b.y1 / height));
        if (x1 > x0 && y1 > y0) lines.push({ text, x: x0, y: y0, width: x1 - x0, height: y1 - y0 });
      }
    }
  }
  return { text: data.text?.trim() || lines.map(line => line.text).join('\n'), lines, confidence: data.confidence };
}

/** Paddle's quadrilateral boxes are converted to the overlay's axis-aligned line format. */
export function normalizePaddleResult(result, width, height) {
  const lines = [];
  for (const item of result?.items ?? []) {
    const text = item.text?.trim();
    if (!text || !Array.isArray(item.poly) || item.poly.length < 4 || !item.poly.every(p => Array.isArray(p) && p.length === 2 && p.every(Number.isFinite))) continue;
    const xs = item.poly.map(p => p[0] / width), ys = item.poly.map(p => p[1] / height);
    const x = Math.max(0, Math.min(1, Math.min(...xs))), y = Math.max(0, Math.min(1, Math.min(...ys)));
    const right = Math.max(x, Math.min(1, Math.max(...xs))), bottom = Math.max(y, Math.min(1, Math.max(...ys)));
    if (right > x && bottom > y) lines.push({ text, x, y, width: right - x, height: bottom - y });
  }
  return { text: lines.map(line => line.text).join('\n'), lines };
}
