// @vitest-environment jsdom
import { act, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const annotateMocks = vi.hoisted(() => ({
  layoutAnnotations: vi.fn(),
}));

vi.mock('@/lib/annotate', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/annotate')>()),
  layoutAnnotations: annotateMocks.layoutAnnotations,
}));

import MultiHighlightThumbnail from '@/components/MultiHighlightThumbnail';

type ResizeCallback = ResizeObserverCallback;

describe('MultiHighlightThumbnail', () => {
  let resizeCallback: ResizeCallback;
  let animationFrames: Map<number, FrameRequestCallback>;
  let nextFrame: number;

  beforeEach(() => {
    animationFrames = new Map();
    nextFrame = 1;
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(callback: ResizeCallback) {
          resizeCallback = callback;
        }
        observe() {}
        disconnect() {}
        unobserve() {}
      },
    );
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      const id = nextFrame++;
      animationFrames.set(id, callback);
      return id;
    });
    vi.stubGlobal('cancelAnimationFrame', (id: number) => animationFrames.delete(id));
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:thumbnail');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    annotateMocks.layoutAnnotations.mockReturnValue([
      {
        order: 1,
        frame: { x: 10, y: 20, width: 40, height: 30 },
        anchor: { x: 30, y: 35 },
        markerOnly: false,
        badgeAnchor: { x: 50, y: 20 },
        callout: null,
        leader: [],
      },
    ]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  const flushAnimationFrames = () => {
    const callbacks = [...animationFrames.values()];
    animationFrames.clear();
    callbacks.forEach((callback) => callback(performance.now()));
  };

  it('memoizes image-space layout and coalesces resize mapping into one animation frame', () => {
    let renderedWidth = 400;
    const view = render(
      <MultiHighlightThumbnail
        blob={new Blob(['image'])}
        annotations={[{ bounds: { x: 10, y: 20, width: 40, height: 30 }, order: 1 }]}
        screenshotScale={2}
        numbered
        alt="preview"
        fit="contain"
      />,
    );
    const image = view.container.querySelector<HTMLImageElement>('img')!;
    Object.defineProperties(image, {
      naturalWidth: { configurable: true, value: 800 },
      naturalHeight: { configurable: true, value: 600 },
      offsetLeft: { configurable: true, value: 0 },
      offsetTop: { configurable: true, value: 0 },
      getBoundingClientRect: {
        configurable: true,
        value: () => ({ x: 0, y: 0, left: 0, top: 0, right: renderedWidth, bottom: 300, width: renderedWidth, height: 300 }),
      },
    });

    act(() => fireEvent.load(image));
    expect(annotateMocks.layoutAnnotations).toHaveBeenCalledOnce();
    expect(annotateMocks.layoutAnnotations).toHaveBeenCalledWith(expect.any(Array), 400, 300);
    act(flushAnimationFrames);

    const frame = view.container.querySelector<HTMLElement>('[data-frametrail-annotation-frame="1"]')!;
    expect(frame.style.left).toBe('10px');

    renderedWidth = 200;
    act(() => {
      resizeCallback([], {} as ResizeObserver);
      resizeCallback([], {} as ResizeObserver);
      resizeCallback([], {} as ResizeObserver);
    });
    expect(animationFrames.size).toBe(1);
    expect(annotateMocks.layoutAnnotations).toHaveBeenCalledOnce();

    act(flushAnimationFrames);
    expect(frame.style.left).toBe('5px');
    expect(annotateMocks.layoutAnnotations).toHaveBeenCalledOnce();
  });

  it('keeps minimum-size markers and badges inside a downscaled thumbnail at every corner', () => {
    annotateMocks.layoutAnnotations.mockReturnValue([
      {
        order: 1,
        frame: { x: 0, y: 0, width: 12, height: 12 },
        anchor: { x: 6, y: 6 },
        markerOnly: true,
        badgeAnchor: { x: 11, y: 11 },
        callout: { x: 11, y: 11 },
        leader: [],
      },
      {
        order: 2,
        frame: { x: 188, y: 0, width: 12, height: 12 },
        anchor: { x: 194, y: 6 },
        markerOnly: true,
        badgeAnchor: { x: 189, y: 11 },
        callout: { x: 189, y: 11 },
        leader: [],
      },
      {
        order: 3,
        frame: { x: 188, y: 88, width: 12, height: 12 },
        anchor: { x: 194, y: 94 },
        markerOnly: true,
        badgeAnchor: { x: 189, y: 89 },
        callout: { x: 189, y: 89 },
        leader: [],
      },
      {
        order: 4,
        frame: { x: 0, y: 88, width: 12, height: 12 },
        anchor: { x: 6, y: 94 },
        markerOnly: true,
        badgeAnchor: { x: 11, y: 89 },
        callout: { x: 11, y: 89 },
        leader: [],
      },
      {
        order: 5,
        frame: { x: 0, y: 0, width: 200, height: 100 },
        anchor: { x: 100, y: 50 },
        markerOnly: false,
        badgeAnchor: { x: 189, y: 11 },
        callout: null,
        leader: [],
      },
    ]);

    const view = render(
      <MultiHighlightThumbnail
        blob={new Blob(['image'])}
        annotations={Array.from({ length: 5 }, (_, index) => ({
          bounds: { x: 0, y: 0, width: 1, height: 1 },
          order: index + 1,
        }))}
        screenshotScale={1}
        numbered
        alt="boundary preview"
        fit="contain"
      />,
    );
    const image = view.container.querySelector<HTMLImageElement>('img')!;
    Object.defineProperties(image, {
      naturalWidth: { configurable: true, value: 200 },
      naturalHeight: { configurable: true, value: 100 },
      offsetLeft: { configurable: true, value: 0 },
      offsetTop: { configurable: true, value: 0 },
      getBoundingClientRect: {
        configurable: true,
        value: () => ({ x: 0, y: 0, left: 0, top: 0, right: 100, bottom: 50, width: 100, height: 50 }),
      },
    });

    act(() => fireEvent.load(image));
    act(flushAnimationFrames);

    const expectElementInsideThumbnail = (element: HTMLElement) => {
      const left = Number.parseFloat(element.style.left) + Number.parseFloat(element.style.marginLeft || '0');
      const top = Number.parseFloat(element.style.top) + Number.parseFloat(element.style.marginTop || '0');
      const width = Number.parseFloat(element.style.width);
      const height = Number.parseFloat(element.style.height);
      expect(left).toBeGreaterThanOrEqual(0);
      expect(top).toBeGreaterThanOrEqual(0);
      expect(left + width).toBeLessThanOrEqual(100);
      expect(top + height).toBeLessThanOrEqual(50);
    };

    const markers = [...view.container.querySelectorAll<HTMLElement>('.pointer-events-none.rounded-full.bg-white')];
    const badges = [...view.container.querySelectorAll<HTMLElement>('.pointer-events-none.font-semibold.shadow')];
    expect(markers).toHaveLength(4);
    expect(badges).toHaveLength(5);
    markers.forEach(expectElementInsideThumbnail);
    badges.forEach(expectElementInsideThumbnail);

    const fullViewportFrame = view.container.querySelector<HTMLElement>('[data-frametrail-annotation-frame="5"]')!;
    expect(fullViewportFrame.style.left).toBe('0px');
    expect(fullViewportFrame.style.top).toBe('0px');
    expect(fullViewportFrame.style.width).toBe('100px');
    expect(fullViewportFrame.style.height).toBe('50px');
  });

  it('maps opaque redactions above all annotation frames and badges', () => {
    const view = render(
      <MultiHighlightThumbnail
        blob={new Blob(['image'])}
        annotations={[{ bounds: { x: 10, y: 20, width: 40, height: 30 }, order: 1 }]}
        redactions={[{ id: 'mask-1', kind: 'solid', bounds: { x: 50, y: 20, width: 30, height: 40 } }]}
        screenshotScale={1}
        numbered
        alt="redacted preview"
        fit="contain"
      />,
    );
    const image = view.container.querySelector<HTMLImageElement>('img')!;
    Object.defineProperties(image, {
      naturalWidth: { configurable: true, value: 200 },
      naturalHeight: { configurable: true, value: 100 },
      offsetLeft: { configurable: true, value: 0 },
      offsetTop: { configurable: true, value: 0 },
      getBoundingClientRect: {
        configurable: true,
        value: () => ({ x: 0, y: 0, left: 0, top: 0, right: 100, bottom: 50, width: 100, height: 50 }),
      },
    });

    expect(image.style.visibility).toBe('hidden');
    expect(view.container.firstElementChild?.className).toContain('bg-black');

    act(() => fireEvent.load(image));
    act(flushAnimationFrames);
    expect(image.style.visibility).toBe('');

    act(() => resizeCallback([], {} as ResizeObserver));
    expect(image.style.visibility).toBe('hidden');
    act(flushAnimationFrames);
    expect(image.style.visibility).toBe('');

    const frame = view.container.querySelector<HTMLElement>('[data-frametrail-annotation-frame="1"]')!;
    const badge = view.container.querySelector<HTMLElement>('.pointer-events-none.font-semibold.shadow')!;
    const redaction = view.container.querySelector<HTMLElement>('[data-frametrail-redaction="mask-1"]')!;
    expect(redaction.style.left).toBe('24px');
    expect(redaction.style.top).toBe('9px');
    expect(redaction.style.width).toBe('17px');
    expect(redaction.style.height).toBe('22px');
    expect(redaction.style.backgroundColor).toBe('rgb(0, 0, 0)');
    expect(redaction.className).toContain('z-10');
    expect(frame.compareDocumentPosition(redaction) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
    expect(badge.compareDocumentPosition(redaction) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
  });
});
