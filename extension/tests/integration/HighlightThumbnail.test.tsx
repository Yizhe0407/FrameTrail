// @vitest-environment jsdom
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import HighlightThumbnail from '@/components/HighlightThumbnail';

describe('HighlightThumbnail', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(_callback: ResizeObserverCallback) {}
        observe() {}
        disconnect() {}
        unobserve() {}
      },
    );
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
});
