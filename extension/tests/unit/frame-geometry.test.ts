import { describe, expect, it } from 'vitest';
import { createFrameCoordinateMapper } from '@/lib/frame-geometry';

function frame(overrides: Record<string, unknown> = {}): HTMLIFrameElement {
  return {
    offsetWidth: 300,
    offsetHeight: 200,
    clientLeft: 2,
    clientTop: 4,
    getBoundingClientRect: () => ({ left: 100, top: 50, width: 600, height: 400 }),
    ...overrides,
  } as unknown as HTMLIFrameElement;
}

describe('createFrameCoordinateMapper', () => {
  it('accounts for iframe borders and axis-aligned transforms', () => {
    const mapper = createFrameCoordinateMapper(frame())!;

    expect(mapper.toChildPoint({ x: 144, y: 78 })).toEqual({ x: 20, y: 10 });
    expect(mapper.toParentBounds({ x: 20, y: 10, width: 40, height: 30 })).toEqual({
      x: 144,
      y: 78,
      width: 80,
      height: 60,
    });
  });

  it('uses the affine border quad for rotated and skewed frames', () => {
    const mapper = createFrameCoordinateMapper(
      frame({
        offsetWidth: 100,
        offsetHeight: 50,
        clientLeft: 2,
        clientTop: 3,
        getBoxQuads: () => [
          {
            p1: { x: 200, y: 100 },
            p2: { x: 200, y: 300 },
            p3: { x: 100, y: 300 },
            p4: { x: 100, y: 100 },
          },
        ],
      }),
    )!;

    expect(mapper.toChildPoint({ x: 184, y: 124 })).toEqual({ x: 10, y: 5 });
    expect(mapper.toParentBounds({ x: 10, y: 5, width: 20, height: 10 })).toEqual({
      x: 164,
      y: 124,
      width: 20,
      height: 40,
    });
  });

  it('rejects degenerate frame geometry', () => {
    expect(createFrameCoordinateMapper(frame({ offsetWidth: 0 }))).toBeNull();
  });
});
