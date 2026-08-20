import { describe, expect, it } from 'vitest';

import { calculateWheelZoom, INITIAL_VIEWER_TRANSFORM, MAX_VIEWER_SCALE, MIN_VIEWER_SCALE } from './openImageInNewTab';

describe('calculateWheelZoom', () => {
  it('zooms in around the pointer', () => {
    const result = calculateWheelZoom(INITIAL_VIEWER_TRANSFORM, -100, { x: 100, y: 50 });

    expect(result.scale).toBeGreaterThan(1);
    expect(result.x).toBeLessThan(0);
    expect(result.y).toBeLessThan(0);
  });

  it('clamps the scale range', () => {
    expect(calculateWheelZoom(INITIAL_VIEWER_TRANSFORM, -100_000, { x: 0, y: 0 }).scale).toBe(MAX_VIEWER_SCALE);
    expect(calculateWheelZoom(INITIAL_VIEWER_TRANSFORM, 100_000, { x: 0, y: 0 }).scale).toBe(MIN_VIEWER_SCALE);
  });

  it('keeps the viewport center fixed when zooming at the center', () => {
    const result = calculateWheelZoom({ scale: 2, x: 10, y: -20 }, -50, { x: 0, y: 0 });
    const ratio = result.scale / 2;

    expect(result.x).toBeCloseTo(10 * ratio);
    expect(result.y).toBeCloseTo(-20 * ratio);
  });
});
