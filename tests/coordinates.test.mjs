import test from 'node:test';
import assert from 'node:assert/strict';
import '../extension/geometry.js';
import { normalizeResult, normalizePaddleResult } from '../extension/ocr-result.js';
const { imageRect } = globalThis.PicOcrGeometry;
const box = { left: 10, top: 20, width: 400, height: 400 };
test('contain accounts for letterboxing', () => {
  assert.deepEqual(imageRect(box, 800, 400, 'contain'), { left: 10, top: 120, width: 400, height: 200 });
});
test('cover maps cropped original coordinates', () => {
  assert.deepEqual(imageRect(box, 800, 400, 'cover'), { left: -190, top: 20, width: 800, height: 400 });
});
test('object-position and scale-down preserve alignment', () => {
  assert.deepEqual(imageRect(box, 200, 100, 'scale-down', '100% 0%'), { left: 210, top: 20, width: 200, height: 100 });
});
test('fill maps nonuniform scaling', () => {
  assert.deepEqual(imageRect(box, 800, 400, 'fill'), box);
});
test('nested Tesseract blocks produce normalized lines; malformed coordinates are ignored', () => {
  const result = normalizeResult({ text: ' hello\n', blocks: [{ paragraphs: [{ lines: [
    { text: 'hello', bbox: { x0: 10, y0: 20, x1: 50, y1: 40 } },
    { text: 'broken', bbox: { x0: NaN, y0: 0, x1: 3, y1: 4 } },
  ] }] }] }, 100, 200);
  assert.equal(result.text, 'hello');
  assert.deepEqual(result.lines, [{ text: 'hello', x: .1, y: .1, width: .4, height: .1 }]);
});
test('empty recognition is a successful empty result', () => {
  assert.deepEqual(normalizeResult({}, 100, 100), { text: '', lines: [], confidence: undefined });
});
test('Paddle quadrilaterals map to the same normalized overlay coordinate space', () => {
  const result = normalizePaddleResult({ items: [
    { text: '  你好 OCR  ', poly: [[10,20],[50,22],[48,40],[8,38]] },
    { text: 'bad', poly: [[NaN,0],[1,1],[2,2],[3,3]] },
  ] }, 100, 200);
  assert.equal(result.text, '你好 OCR');
  assert.deepEqual(result.lines, [{ text: '你好 OCR', x: .08, y: .1, width: .42, height: .1 }]);
  assert.deepEqual(normalizePaddleResult(null, 100, 100), { text: '', lines: [] });
});
