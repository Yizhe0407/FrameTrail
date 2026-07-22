export const REGION_CAPTURE_MIN_SIZE = 8;

export interface RegionPoint {
  x: number;
  y: number;
}

export interface RegionViewport {
  width: number;
  height: number;
}

export interface RegionRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type RegionCaptureCancelReason = 'user' | 'escape' | 'viewport' | 'removed';

export interface RegionCaptureOptions {
  onCapture(rect: RegionRect): void | Promise<void>;
  onCancel?(reason: RegionCaptureCancelReason): void | Promise<void>;
  onClose?(): void;
  minSize?: number;
  /** Steps mode needs two compositor frames; snapshot annotations can opt out. */
  settleFrames?: number;
  viewport?: () => RegionViewport;
}

export interface RegionCapture {
  readonly host: HTMLElement;
  isActive(): boolean;
  isCapturing(): boolean;
  cancel(reason?: RegionCaptureCancelReason): void;
  remove(): void;
}

export function clipRegionPoint(point: RegionPoint, viewport: RegionViewport): RegionPoint {
  const width = Number.isFinite(viewport.width) ? Math.max(0, viewport.width) : 0;
  const height = Number.isFinite(viewport.height) ? Math.max(0, viewport.height) : 0;
  const x = Number.isFinite(point.x) ? point.x : 0;
  const y = Number.isFinite(point.y) ? point.y : 0;
  return {
    x: Math.min(Math.max(x, 0), width),
    y: Math.min(Math.max(y, 0), height),
  };
}

export function normalizeRegionRect(
  start: RegionPoint,
  end: RegionPoint,
  viewport: RegionViewport,
): RegionRect {
  const clippedStart = clipRegionPoint(start, viewport);
  const clippedEnd = clipRegionPoint(end, viewport);
  const x = Math.min(clippedStart.x, clippedEnd.x);
  const y = Math.min(clippedStart.y, clippedEnd.y);
  return {
    x,
    y,
    width: Math.max(clippedStart.x, clippedEnd.x) - x,
    height: Math.max(clippedStart.y, clippedEnd.y) - y,
  };
}

export function clipRegionRect(rect: RegionRect, viewport: RegionViewport): RegionRect | null {
  if (
    !Number.isFinite(rect.x) ||
    !Number.isFinite(rect.y) ||
    !Number.isFinite(rect.width) ||
    !Number.isFinite(rect.height) ||
    rect.width < 0 ||
    rect.height < 0
  ) {
    return null;
  }
  return normalizeRegionRect(
    { x: rect.x, y: rect.y },
    { x: rect.x + rect.width, y: rect.y + rect.height },
    viewport,
  );
}

export function isRegionRectLargeEnough(
  rect: RegionRect,
  minSize = REGION_CAPTURE_MIN_SIZE,
): boolean {
  return (
    Number.isFinite(rect.x) &&
    Number.isFinite(rect.y) &&
    Number.isFinite(rect.width) &&
    Number.isFinite(rect.height) &&
    Number.isFinite(minSize) &&
    minSize > 0 &&
    rect.x >= 0 &&
    rect.y >= 0 &&
    rect.width >= minSize &&
    rect.height >= minSize
  );
}

export function isRegionRectInsideViewport(
  rect: RegionRect,
  viewport: RegionViewport,
  minSize = REGION_CAPTURE_MIN_SIZE,
): boolean {
  return (
    isRegionRectLargeEnough(rect, minSize) &&
    Number.isFinite(viewport.width) &&
    Number.isFinite(viewport.height) &&
    viewport.width >= 0 &&
    viewport.height >= 0 &&
    rect.x + rect.width <= viewport.width &&
    rect.y + rect.height <= viewport.height
  );
}

export async function waitForRegionCapturePaint(frames = 2): Promise<void> {
  for (let index = 0; index < Math.max(0, frames); index += 1) {
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  }
}

const REGION_CAPTURE_STYLES = `
  :host { color-scheme: light dark; }
  * { box-sizing: border-box; }
  .ft-region-blocker {
    position: fixed; inset: 0; overflow: hidden; pointer-events: auto;
    cursor: crosshair; touch-action: none; user-select: none;
    font-family: -apple-system, BlinkMacSystemFont, "Noto Sans TC", "PingFang TC", "Microsoft JhengHei", sans-serif;
  }
  .ft-region-selection {
    position: absolute; display: none; border: 2px solid #f43f5e; border-radius: 4px;
    background: rgb(244 63 94 / .08); box-shadow: 0 0 0 99999px rgb(15 23 42 / .32);
    pointer-events: none;
  }
  .ft-region-selection[data-visible="true"] { display: block; }
  .ft-region-panel {
    position: fixed; top: 16px; left: 50%; display: flex; align-items: center; gap: 10px;
    max-width: calc(100vw - 32px); min-height: 44px; padding: 6px 8px 6px 14px;
    transform: translateX(-50%); border: 1px solid #d6d3d1; border-radius: 999px;
    background: #fff; color: #1c1917; box-shadow: 0 8px 24px rgb(28 25 23 / .22);
    font-size: 13px; line-height: 1.4; cursor: default; pointer-events: auto;
  }
  .ft-region-status { min-width: 0; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .ft-region-cancel {
    min-width: 40px; min-height: 32px; padding: 0 10px; border: 0; border-radius: 999px;
    background: #f5f5f4; color: #44403c; font: inherit; font-weight: 600; cursor: pointer;
  }
  .ft-region-cancel:hover { background: #e7e5e4; color: #1c1917; }
  .ft-region-cancel:focus-visible { outline: 2px solid #2563eb; outline-offset: 2px; }
  .ft-region-blocker[data-capturing="true"] { cursor: wait; }
  .ft-region-blocker[data-capturing="true"] .ft-region-selection,
  .ft-region-blocker[data-capturing="true"] .ft-region-panel { visibility: hidden; }
  @media (prefers-color-scheme: dark) {
    .ft-region-panel { border-color: #57534e; background: #1c1917; color: #fafaf9; }
    .ft-region-cancel { background: #292524; color: #e7e5e4; }
    .ft-region-cancel:hover { background: #44403c; color: #fff; }
  }
  @media (prefers-reduced-motion: reduce) { * { animation: none !important; transition: none !important; } }
`;

/**
 * Owns a full-viewport drag gesture. During capture only the visual children
 * are hidden; the transparent host remains hit-testable until the callback
 * settles, so no page target receives a synthetic follow-up click.
 */
export function createRegionCapture(options: RegionCaptureOptions): RegionCapture {
  const readViewport = options.viewport ?? (() => ({ width: window.innerWidth, height: window.innerHeight }));
  const minSize = options.minSize ?? REGION_CAPTURE_MIN_SIZE;
  const settleFrames = options.settleFrames ?? 2;
  const host = document.createElement('div');
  host.setAttribute('data-frametrail-region-capture', '');
  host.setAttribute('popover', 'manual');
  const declarations: Record<string, string> = {
    all: 'initial',
    position: 'fixed',
    inset: '0',
    width: '100vw',
    height: '100vh',
    margin: '0',
    padding: '0',
    border: '0',
    display: 'block',
    background: 'transparent',
    'pointer-events': 'auto',
    'z-index': '2147483647',
  };
  for (const [property, value] of Object.entries(declarations)) {
    host.style.setProperty(property, value, 'important');
  }

  const root = host.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = REGION_CAPTURE_STYLES;
  const blocker = document.createElement('div');
  blocker.className = 'ft-region-blocker';
  blocker.tabIndex = 0;
  blocker.setAttribute('role', 'application');
  blocker.setAttribute('aria-label', '區域擷取');
  const selection = document.createElement('div');
  selection.className = 'ft-region-selection';
  selection.dataset.visible = 'false';
  const panel = document.createElement('div');
  panel.className = 'ft-region-panel';
  const status = document.createElement('div');
  status.className = 'ft-region-status';
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  status.textContent = '拖曳選取要擷取的區域，按 Esc 可取消';
  const cancelButton = document.createElement('button');
  cancelButton.type = 'button';
  cancelButton.className = 'ft-region-cancel';
  cancelButton.textContent = '取消';
  cancelButton.setAttribute('aria-label', '取消區域擷取');
  panel.append(status, cancelButton);
  blocker.append(selection, panel);
  root.append(style, blocker);

  let closed = false;
  let capturing = false;
  let start: RegionPoint | null = null;
  let pointerId: number | null = null;
  let currentRect: RegionRect | null = null;
  let cancelNotified = false;

  const consume = (event: Event) => {
    if (event.cancelable) event.preventDefault();
    event.stopPropagation();
  };

  const renderRect = (rect: RegionRect | null) => {
    currentRect = rect;
    if (!rect || rect.width === 0 || rect.height === 0) {
      selection.dataset.visible = 'false';
      return;
    }
    selection.dataset.visible = 'true';
    selection.style.left = `${rect.x}px`;
    selection.style.top = `${rect.y}px`;
    selection.style.width = `${rect.width}px`;
    selection.style.height = `${rect.height}px`;
  };

  const close = (notify = true) => {
    if (closed) return;
    closed = true;
    window.removeEventListener('keydown', onKeyDown, true);
    window.removeEventListener('resize', onResize, true);
    host.remove();
    if (notify) options.onClose?.();
  };

  const cancel = (reason: RegionCaptureCancelReason = 'user') => {
    if (closed) return;
    if (!cancelNotified) {
      cancelNotified = true;
      void options.onCancel?.(reason);
    }
    close();
  };

  const onPointerDown = (event: PointerEvent) => {
    consume(event);
    if (capturing || event.button !== 0 || !event.isPrimary) return;
    start = clipRegionPoint({ x: event.clientX, y: event.clientY }, readViewport());
    pointerId = event.pointerId;
    renderRect(normalizeRegionRect(start, start, readViewport()));
    status.textContent = '拖曳中；放開以擷取，按 Esc 可取消';
    blocker.setPointerCapture?.(event.pointerId);
  };

  const onPointerMove = (event: PointerEvent) => {
    consume(event);
    if (capturing || start === null || pointerId !== event.pointerId) return;
    renderRect(normalizeRegionRect(start, { x: event.clientX, y: event.clientY }, readViewport()));
  };

  const onPointerUp = (event: PointerEvent) => {
    consume(event);
    if (capturing || start === null || pointerId !== event.pointerId) return;
    if (blocker.hasPointerCapture?.(event.pointerId)) blocker.releasePointerCapture?.(event.pointerId);
    const rect = normalizeRegionRect(start, { x: event.clientX, y: event.clientY }, readViewport());
    start = null;
    pointerId = null;
    renderRect(rect);
    if (!isRegionRectInsideViewport(rect, readViewport(), minSize)) {
      renderRect(null);
      status.textContent = `選取範圍太小，寬高至少需 ${minSize} 像素，請重新拖曳`;
      return;
    }

    capturing = true;
    blocker.dataset.capturing = 'true';
    status.textContent = '正在擷取選取區域';
    void (async () => {
      try {
        await waitForRegionCapturePaint(settleFrames);
        if (closed) return;
        await options.onCapture(rect);
      } catch (error) {
        console.error('[frametrail] failed to capture selected region', error);
      } finally {
        close();
      }
    })();
  };

  const onPointerCancel = (event: PointerEvent) => {
    consume(event);
    cancel('user');
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Escape') {
      consume(event);
      cancel('escape');
      return;
    }
    if (event.key === 'Tab' && event.target === cancelButton) return;
    consume(event);
  };

  const onResize = () => cancel('viewport');

  blocker.addEventListener('pointerdown', onPointerDown);
  blocker.addEventListener('pointermove', onPointerMove);
  blocker.addEventListener('pointerup', onPointerUp);
  blocker.addEventListener('pointercancel', onPointerCancel);
  blocker.addEventListener('click', consume);
  blocker.addEventListener('contextmenu', consume);
  blocker.addEventListener('wheel', consume, { passive: false });
  cancelButton.addEventListener('click', (event) => {
    consume(event);
    cancel('user');
  });
  window.addEventListener('keydown', onKeyDown, { capture: true });
  window.addEventListener('resize', onResize, { capture: true });

  document.documentElement.append(host);
  const showPopover = (host as HTMLElement & { showPopover?: () => void }).showPopover;
  try {
    showPopover?.call(host);
  } catch {
    // Popover support is optional; the hardened z-index remains the fallback.
  }
  queueMicrotask(() => blocker.focus({ preventScroll: true }));

  return {
    host,
    isActive: () => !closed,
    isCapturing: () => capturing && !closed,
    cancel,
    remove() {
      if (!closed) cancel('removed');
    },
  };
}
