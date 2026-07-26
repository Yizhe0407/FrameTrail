import { vi } from 'vitest';

/**
 * Shared jsdom scaffolding for the thumbnail component suites
 * (HighlightThumbnail / MultiHighlightThumbnail): both remap overlays through
 * ResizeObserver + requestAnimationFrame against a stubbed object URL, so the
 * stubs and the image-metric fakes live here instead of being cloned per file.
 */
export interface ThumbnailDomStubs {
  /** Pending animation-frame callbacks keyed by handle. */
  animationFrames: Map<number, FrameRequestCallback>;
  /** Fires the captured ResizeObserver callback, as a real resize would. */
  triggerResize(): void;
  /** Runs and clears every queued animation frame. */
  flushAnimationFrames(): void;
}

/**
 * Installs ResizeObserver / rAF globals and URL object-URL spies. Call inside
 * beforeEach; pair with vi.unstubAllGlobals() + vi.restoreAllMocks() in
 * afterEach.
 */
export function installThumbnailDomStubs(): ThumbnailDomStubs {
  const animationFrames = new Map<number, FrameRequestCallback>();
  let nextFrame = 1;
  let resizeCallback: ResizeObserverCallback | undefined;

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
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:thumbnail');
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});

  return {
    animationFrames,
    triggerResize: () => resizeCallback?.([], {} as ResizeObserver),
    flushAnimationFrames: () => {
      const callbacks = [...animationFrames.values()];
      animationFrames.clear();
      callbacks.forEach((callback) => callback(performance.now()));
    },
  };
}

export interface ImageMetrics {
  naturalWidth: number;
  naturalHeight: number;
  offsetLeft?: number;
  offsetTop?: number;
  /** Rendered CSS size; pass a function when a test resizes mid-flight. */
  rendered: { width: number; height: number } | (() => { width: number; height: number });
}

/**
 * jsdom images have no layout; fake the natural/rendered metrics the mapping
 * code reads. The rect is anchored at the origin, matching the suites' fixed
 * container.
 */
export function stubImageMetrics(image: HTMLImageElement, metrics: ImageMetrics): void {
  const rendered = typeof metrics.rendered === 'function' ? metrics.rendered : () => metrics.rendered as { width: number; height: number };
  Object.defineProperties(image, {
    naturalWidth: { configurable: true, value: metrics.naturalWidth },
    naturalHeight: { configurable: true, value: metrics.naturalHeight },
    offsetLeft: { configurable: true, value: metrics.offsetLeft ?? 0 },
    offsetTop: { configurable: true, value: metrics.offsetTop ?? 0 },
    getBoundingClientRect: {
      configurable: true,
      value: () => {
        const { width, height } = rendered();
        return { x: 0, y: 0, left: 0, top: 0, right: width, bottom: height, width, height };
      },
    },
  });
}
