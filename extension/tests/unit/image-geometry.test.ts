// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { createImageCoordinateMapper } from '@/lib/image-geometry';

function defineMetric(image: HTMLImageElement, name: string, value: number): void {
  Object.defineProperty(image, name, { configurable: true, value });
}

afterEach(() => document.body.replaceChildren());

describe('createImageCoordinateMapper', () => {
  it('maps through scaled borders and padding', () => {
    const image = document.createElement('img');
    image.style.padding = '4px';
    image.style.objectFit = 'fill';
    document.body.append(image);
    defineMetric(image, 'offsetWidth', 100);
    defineMetric(image, 'offsetHeight', 80);
    defineMetric(image, 'clientLeft', 2);
    defineMetric(image, 'clientTop', 2);
    defineMetric(image, 'clientWidth', 96);
    defineMetric(image, 'clientHeight', 76);
    image.getBoundingClientRect = () =>
      ({ left: 100, top: 50, width: 200, height: 160 } as DOMRect);

    const mapper = createImageCoordinateMapper(image, 440, 340)!;

    expect(mapper.contentBounds).toEqual({ x: 112, y: 62, width: 176, height: 136 });
    expect(mapper.toSourcePoint(200, 130)).toEqual({ x: 220, y: 170 });
    expect(mapper.toViewportBounds({ x: 110, y: 85, width: 220, height: 170 })).toEqual({
      x: 156,
      y: 96,
      width: 88,
      height: 68,
    });
  });

  it('excludes object-fit contain letterboxing from image-map coordinates', () => {
    const image = document.createElement('img');
    image.style.objectFit = 'contain';
    image.style.objectPosition = '50% 50%';
    document.body.append(image);
    defineMetric(image, 'offsetWidth', 200);
    defineMetric(image, 'offsetHeight', 100);
    defineMetric(image, 'clientLeft', 0);
    defineMetric(image, 'clientTop', 0);
    defineMetric(image, 'clientWidth', 200);
    defineMetric(image, 'clientHeight', 100);
    image.getBoundingClientRect = () =>
      ({ left: 10, top: 20, width: 200, height: 100 } as DOMRect);

    const mapper = createImageCoordinateMapper(image, 100, 100)!;

    expect(mapper.toSourcePoint(60, 70)).toEqual({ x: 0, y: 50 });
    expect(mapper.toViewportBounds({ x: 0, y: 0, width: 100, height: 100 })).toEqual({
      x: 60,
      y: 20,
      width: 100,
      height: 100,
    });
  });

  it('maps image areas through a rotated border-box quad', () => {
    const image = document.createElement('img') as HTMLImageElement & {
      getBoxQuads: () => Array<{
        p1: { x: number; y: number };
        p2: { x: number; y: number };
        p3: { x: number; y: number };
        p4: { x: number; y: number };
      }>;
    };
    image.style.objectFit = 'fill';
    document.body.append(image);
    defineMetric(image, 'offsetWidth', 100);
    defineMetric(image, 'offsetHeight', 100);
    defineMetric(image, 'clientLeft', 0);
    defineMetric(image, 'clientTop', 0);
    defineMetric(image, 'clientWidth', 100);
    defineMetric(image, 'clientHeight', 100);
    image.getBoxQuads = () => [
      {
        p1: { x: 200, y: 100 },
        p2: { x: 200, y: 300 },
        p3: { x: 0, y: 300 },
        p4: { x: 0, y: 100 },
      },
    ];

    const mapper = createImageCoordinateMapper(image, 100, 100)!;

    expect(mapper.toSourcePoint(100, 150)).toEqual({ x: 25, y: 50 });
    expect(mapper.toViewportBounds({ x: 10, y: 20, width: 30, height: 40 })).toEqual({
      x: 80,
      y: 120,
      width: 80,
      height: 60,
    });
  });
});
