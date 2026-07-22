// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createRegionCapture,
  isRegionRectInsideViewport,
  isRegionRectLargeEnough,
  normalizeRegionRect,
} from '@/lib/region-capture';

const viewport = { width: 100, height: 80 };

function pointerEvent(type: string, x: number, y: number): PointerEvent {
  const event = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    button: 0,
    clientX: x,
    clientY: y,
  });
  Object.defineProperties(event, {
    isPrimary: { value: true },
    pointerId: { value: 1 },
  });
  return event as PointerEvent;
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

afterEach(() => {
  document.querySelectorAll('[data-frametrail-region-capture]').forEach((element) => element.remove());
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('region capture geometry', () => {
  it.each([
    [{ x: 20, y: 10 }, { x: 80, y: 70 }],
    [{ x: 80, y: 10 }, { x: 20, y: 70 }],
    [{ x: 20, y: 70 }, { x: 80, y: 10 }],
    [{ x: 80, y: 70 }, { x: 20, y: 10 }],
  ])('normalizes all drag directions', (start, end) => {
    expect(normalizeRegionRect(start, end, viewport)).toEqual({ x: 20, y: 10, width: 60, height: 60 });
  });

  it('clips both endpoints to the viewport', () => {
    expect(normalizeRegionRect({ x: -20, y: 10 }, { x: 120, y: 90 }, viewport)).toEqual({
      x: 0,
      y: 10,
      width: 100,
      height: 70,
    });
  });

  it('requires finite in-viewport rectangles of the minimum size', () => {
    expect(isRegionRectLargeEnough({ x: 0, y: 0, width: 8, height: 8 })).toBe(true);
    expect(isRegionRectLargeEnough({ x: 0, y: 0, width: 7.99, height: 8 })).toBe(false);
    expect(isRegionRectLargeEnough({ x: 0, y: 0, width: Number.NaN, height: 8 })).toBe(false);
    expect(isRegionRectInsideViewport({ x: 92, y: 72, width: 8, height: 8 }, viewport)).toBe(true);
    expect(isRegionRectInsideViewport({ x: 93, y: 72, width: 8, height: 8 }, viewport)).toBe(false);
  });
});

describe('createRegionCapture', () => {
  it('hides visuals, waits two frames, and keeps the blocker until capture settles', async () => {
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal('requestAnimationFrame', vi.fn((callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    }));
    let finishCapture!: () => void;
    const onCapture = vi.fn(() => new Promise<void>((resolve) => { finishCapture = resolve; }));
    const controller = createRegionCapture({ onCapture, viewport: () => viewport });
    const blocker = controller.host.shadowRoot!.querySelector<HTMLElement>('.ft-region-blocker')!;

    blocker.dispatchEvent(pointerEvent('pointerdown', 10, 12));
    blocker.dispatchEvent(pointerEvent('pointermove', 50, 52));
    blocker.dispatchEvent(pointerEvent('pointerup', 50, 52));

    expect(controller.isCapturing()).toBe(true);
    expect(blocker.dataset.capturing).toBe('true');
    expect(controller.host.isConnected).toBe(true);
    expect(onCapture).not.toHaveBeenCalled();
    expect(frames).toHaveLength(1);

    frames.shift()!(0);
    await flushMicrotasks();
    expect(onCapture).not.toHaveBeenCalled();
    expect(frames).toHaveLength(1);

    frames.shift()!(16);
    await flushMicrotasks();
    expect(onCapture).toHaveBeenCalledWith({ x: 10, y: 12, width: 40, height: 40 });
    expect(controller.host.isConnected).toBe(true);

    finishCapture();
    await flushMicrotasks();
    expect(controller.host.isConnected).toBe(false);
  });

  it('supports Escape cancellation without capturing', () => {
    const onCancel = vi.fn();
    const onCapture = vi.fn();
    const controller = createRegionCapture({ onCapture, onCancel, viewport: () => viewport });

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', cancelable: true }));

    expect(onCancel).toHaveBeenCalledWith('escape');
    expect(onCapture).not.toHaveBeenCalled();
    expect(controller.isActive()).toBe(false);
  });
});
