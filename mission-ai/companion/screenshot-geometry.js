import { randomUUID } from 'node:crypto';

export function createScreenshotGeometryStore({ now = Date.now, randomId = randomUUID } = {}) {
  const images = new Map();
  function display(value) {
    if (!value || !Number.isSafeInteger(value.id) || value.id <= 0 ||
        !['x', 'y', 'width', 'height'].every((key) => Number.isFinite(value[key])) ||
        value.width <= 0 || value.height <= 0 || value.width > 20000 || value.height > 20000) {
      throw new Error('display_geometry_unavailable');
    }
    return { id: value.id, x: value.x, y: value.y, width: value.width, height: value.height };
  }
  return {
    remember(currentDisplay, dimensions) {
      const frame = display(currentDisplay);
      if (!dimensions || !['width', 'height'].every((key) => Number.isSafeInteger(dimensions[key]) &&
          dimensions[key] > 0 && dimensions[key] <= 1600)) throw new Error('screenshot_dimensions_invalid');
      const screenshotId = randomId();
      const value = { screenshotId, imageWidth: dimensions.width, imageHeight: dimensions.height,
        display: frame, capturedAt: now() };
      images.set(screenshotId, value);
      while (images.size > 8) images.delete(images.keys().next().value);
      return structuredClone(value);
    },
    resolve(args, currentDisplay) {
      if (!args || Object.keys(args).some((key) => !['screenshotId', 'x', 'y'].includes(key))) {
        throw new Error('invalid_coordinates');
      }
      const saved = images.get(args.screenshotId);
      const age = saved ? now() - saved.capturedAt : Infinity;
      if (!saved || age < 0 || age > 120000) throw new Error('fresh_screenshot_required');
      const frame = display(currentDisplay);
      if (Object.keys(frame).some((key) => frame[key] !== saved.display[key])) {
        throw new Error('display_geometry_changed');
      }
      if (typeof args.x !== 'number' || typeof args.y !== 'number' ||
          !Number.isFinite(args.x) || !Number.isFinite(args.y) ||
          args.x < 0 || args.y < 0 || args.x >= saved.imageWidth || args.y >= saved.imageHeight) {
        throw new Error('invalid_coordinates');
      }
      return { screenshotId: saved.screenshotId, x: args.x, y: args.y,
        screenX: Math.min(Math.ceil(frame.x + frame.width) - 1, Math.round(frame.x + args.x * frame.width / saved.imageWidth)),
        screenY: Math.min(Math.ceil(frame.y + frame.height) - 1, Math.round(frame.y + args.y * frame.height / saved.imageHeight)) };
    },
    clear() { images.clear(); },
  };
}
