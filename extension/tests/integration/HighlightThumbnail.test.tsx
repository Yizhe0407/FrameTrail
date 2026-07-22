// @vitest-environment jsdom
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import HighlightThumbnail from '@/components/HighlightThumbnail';

describe('HighlightThumbnail', () => {
  let resizeCallback: ResizeObserverCallback;
  let animationFrames: Map<number, FrameRequestCallback>;
  let nextFrame: number;

  beforeEach(() => {
    animationFrames = new Map();
    nextFrame = 1;
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(callback: ResizeObserverCallback) {
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
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:highlight-thumbnail');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('keeps full-viewport and corner frames inside a downscaled thumbnail', () => {
    const cases = [
      {
        name: 'full viewport',
        bounds: { x: 0, y: 0, width: 200, height: 100 },
        expectedEdges: { left: 0, top: 0, right: 100, bottom: 50 },
      },
      {
        name: 'top left',
        bounds: { x: 0, y: 0, width: 20, height: 16 },
        expectedEdges: { left: 0, top: 0 },
      },
      {
        name: 'top right',
        bounds: { x: 180, y: 0, width: 20, height: 16 },
        expectedEdges: { top: 0, right: 100 },
      },
      {
        name: 'bottom right',
        bounds: { x: 180, y: 84, width: 20, height: 16 },
        expectedEdges: { right: 100, bottom: 50 },
      },
      {
        name: 'bottom left',
        bounds: { x: 0, y: 84, width: 20, height: 16 },
        expectedEdges: { left: 0, bottom: 50 },
      },
    ];

    for (const { name, bounds, expectedEdges } of cases) {
      const view = render(
        <HighlightThumbnail
          blob={new Blob(['image'])}
          bounds={bounds}
          screenshotScale={1}
          alt={name}
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

      const overlay = view.container.querySelector<HTMLElement>('.pointer-events-none.absolute.box-border')!;
      const left = Number.parseFloat(overlay.style.left);
      const top = Number.parseFloat(overlay.style.top);
      const right = left + Number.parseFloat(overlay.style.width);
      const bottom = top + Number.parseFloat(overlay.style.height);

      expect(left, `${name} left`).toBeGreaterThanOrEqual(0);
      expect(top, `${name} top`).toBeGreaterThanOrEqual(0);
      expect(right, `${name} right`).toBeLessThanOrEqual(100);
      expect(bottom, `${name} bottom`).toBeLessThanOrEqual(50);
      if (expectedEdges.left !== undefined) expect(left, `${name} left edge`).toBe(expectedEdges.left);
      if (expectedEdges.top !== undefined) expect(top, `${name} top edge`).toBe(expectedEdges.top);
      if (expectedEdges.right !== undefined) expect(right, `${name} right edge`).toBe(expectedEdges.right);
      if (expectedEdges.bottom !== undefined) expect(bottom, `${name} bottom edge`).toBe(expectedEdges.bottom);

      view.unmount();
    }
  });

  // Redactions use the same CSS-coordinate-to-image mapping as highlights, but
  // render last so privacy masks always cover the annotation chrome beneath.
  it('maps opaque redactions from screenshot CSS coordinates above the highlight', () => {
    const view = render(
      <HighlightThumbnail
        blob={new Blob(['image'])}
        bounds={{ x: 40, y: 10, width: 40, height: 20 }}
        redactions={[{ id: 'mask-1', kind: 'solid', bounds: { x: 50, y: 20, width: 30, height: 40 } }]}
        screenshotScale={1}
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
    expect(image.style.visibility).toBe('');

    const highlight = view.container.querySelector<HTMLElement>('.pointer-events-none.absolute.box-border')!;
    const redaction = view.container.querySelector<HTMLElement>('[data-frametrail-redaction="mask-1"]')!;
    expect(redaction.style.left).toBe('24px');
    expect(redaction.style.top).toBe('9px');
    expect(redaction.style.width).toBe('17px');
    expect(redaction.style.height).toBe('22px');
    expect(redaction.style.backgroundColor).toBe('rgb(0, 0, 0)');
    expect(redaction.className).toContain('z-10');
    expect(highlight.compareDocumentPosition(redaction) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
  });
  it('hides source pixels while a resize remaps a redaction overlay', () => {
    const view = render(
      <HighlightThumbnail
        blob={new Blob(['image'])}
        bounds={{ x: 10, y: 10, width: 30, height: 20 }}
        redactions={[{ id: 'mask-1', kind: 'solid', bounds: { x: 50, y: 20, width: 30, height: 40 } }]}
        screenshotScale={1}
        alt="resizing redacted preview"
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
    expect(image.style.visibility).toBe('');
    act(() => resizeCallback([], {} as ResizeObserver));
    expect(image.style.visibility).toBe('hidden');
    act(() => {
      const frame = [...animationFrames.values()][0];
      frame?.(performance.now());
    });
    expect(image.style.visibility).toBe('');
  });

});
