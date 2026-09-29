import test from 'node:test';
import assert from 'node:assert/strict';
import { createScreenshotGeometryStore } from './screenshot-geometry.js';
const frame = { id: 1, x: 0, y: 0, width: 1710, height: 1107 };
function fixture() {
  let time = 1000; let counter = 0;
  const store = createScreenshotGeometryStore({ now: () => time, randomId: () => `shot-${++counter}` });
  const saved = store.remember(frame, { width: 1600, height: 1036 });
  return { store, saved, advance: (n) => { time += n; } };
}
test('resized screenshot coordinates map to logical display points rather than original image pixels', () => {
  const { store, saved } = fixture();
  assert.deepEqual(store.resolve({ screenshotId: saved.screenshotId, x: 800, y: 518 }, frame),
    { screenshotId: 'shot-1', x: 800, y: 518, screenX: 855, screenY: 554 });
  const edge = store.resolve({ screenshotId: saved.screenshotId, x: 1599.9, y: 1035.9 }, frame);
  assert.equal(edge.screenX, 1709); assert.equal(edge.screenY, 1106);
});
test('display changes, expired or absent screenshot IDs and client-supplied screen coordinates fail closed', () => {
  const { store, saved, advance } = fixture(); const args = { screenshotId: saved.screenshotId, x: 100, y: 100 };
  for (const key of ['id', 'x', 'y', 'width', 'height']) {
    assert.throws(() => store.resolve(args, { ...frame, [key]: frame[key] + 1 }), /display_geometry_changed/);
  }
  for (const patch of [{ screenshotId: 'missing' }, { x: -1 }, { x: 1600 }, { y: 1036 },
    { x: '100' }, { y: NaN }, { screenX: 2 }]) assert.throws(() => store.resolve({ ...args, ...patch }, frame));
  advance(120001); assert.throws(() => store.resolve(args, frame), /fresh_screenshot_required/);
});
test('stored geometry cannot be modified by callers and clearing invalidates old screenshots', () => {
  const { store, saved } = fixture(); saved.display.width = 999;
  const args = { screenshotId: saved.screenshotId, x: 800, y: 518 };
  assert.equal(store.resolve(args, frame).screenX, 855);
  store.clear(); assert.throws(() => store.resolve(args, frame), /fresh_screenshot_required/);
});
test('unavailable display geometry and oversize or invalid image dimensions are refused', () => {
  const { store } = fixture();
  assert.throws(() => store.remember({ ...frame, id: 0 }, { width: 100, height: 100 }), /display_geometry_unavailable/);
  for (const dimensions of [{ width: 1601, height: 100 }, { width: 100, height: 0 }, { width: NaN, height: 100 }]) {
    assert.throws(() => store.remember(frame, dimensions), /screenshot_dimensions_invalid/);
  }
});
