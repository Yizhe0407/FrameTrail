import {
  HIGHLIGHT_COLOR,
  HIGHLIGHT_LINE_WIDTH,
  HIGHLIGHT_PADDING,
  HIGHLIGHT_PREVIEW_FILL_COLOR,
  HIGHLIGHT_RADIUS,
} from './annotate';
import type { Bounds } from './db';

export interface StepPreview {
  show(bounds: Bounds): void;
  hide(): void;
  prepareForCapture(): Promise<void>;
  remove(): void;
}

function setImportantStyle(element: HTMLElement, property: string, value: string): void {
  element.style.setProperty(property, value, 'important');
}

function waitForNextPaint(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

/** A click-through hover frame for step mode. It lives in a closed shadow root
 * so page CSS cannot alter it, and settles offscreen before capture. */
export function createStepPreview(): StepPreview {
  const host = document.createElement('div');
  host.setAttribute('data-frametrail-step-preview', '');
  host.setAttribute('aria-hidden', 'true');
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
    'box-sizing': 'border-box',
    background: 'transparent',
    opacity: '1',
    visibility: 'visible',
    overflow: 'hidden',
    contain: 'strict',
    transform: 'none',
    filter: 'none',
    animation: 'none',
    transition: 'none',
    'pointer-events': 'none',
    'z-index': '2147483647',
  };
  for (const [property, value] of Object.entries(declarations)) setImportantStyle(host, property, value);

  const shadowRoot = host.attachShadow({ mode: 'closed' });
  const box = document.createElement('div');
  box.className = 'preview';
  box.hidden = true;
  const boxDeclarations: Record<string, string> = {
    position: 'absolute',
    margin: '0',
    padding: '0',
    'box-sizing': 'border-box',
    border: `${HIGHLIGHT_LINE_WIDTH}px solid ${HIGHLIGHT_COLOR}`,
    'border-radius': `${HIGHLIGHT_RADIUS}px`,
    background: HIGHLIGHT_PREVIEW_FILL_COLOR,
    'box-shadow': 'none',
    display: 'none',
    opacity: '1',
    visibility: 'visible',
    transform: 'none',
    filter: 'none',
    animation: 'none',
    transition: 'none',
    'pointer-events': 'none',
  };
  for (const [property, value] of Object.entries(boxDeclarations)) setImportantStyle(box, property, value);
  shadowRoot.append(box);

  let removed = false;
  const mount = () => {
    if (removed || host.isConnected) return;
    document.documentElement.append(host);
  };
  const showInTopLayer = () => {
    if (typeof host.showPopover !== 'function') return;
    try {
      if (!host.matches(':popover-open')) host.showPopover();
    } catch {
      // The fixed z-index fallback remains usable without popover support.
    }
  };
  mount();
  showInTopLayer();

  const observer = new MutationObserver(() => {
    if (!removed && !host.isConnected) {
      mount();
      showInTopLayer();
    }
  });
  observer.observe(document.documentElement, { childList: true });

  const hideBox = () => {
    box.hidden = true;
    setImportantStyle(box, 'display', 'none');
  };

  return {
    show(bounds) {
      if (removed) return;
      mount();
      showInTopLayer();
      const left = Math.max(0, bounds.x - HIGHLIGHT_PADDING);
      const top = Math.max(0, bounds.y - HIGHLIGHT_PADDING);
      const right = Math.min(window.innerWidth, bounds.x + bounds.width + HIGHLIGHT_PADDING);
      const bottom = Math.min(window.innerHeight, bounds.y + bounds.height + HIGHLIGHT_PADDING);
      setImportantStyle(box, 'left', `${left}px`);
      setImportantStyle(box, 'top', `${top}px`);
      setImportantStyle(box, 'width', `${Math.max(0, right - left)}px`);
      setImportantStyle(box, 'height', `${Math.max(0, bottom - top)}px`);
      box.hidden = false;
      setImportantStyle(box, 'display', 'block');
    },
    hide() {
      hideBox();
    },
    async prepareForCapture() {
      hideBox();
      // captureVisibleTab can observe the previous compositor frame even
      // after the DOM is hidden. Two paints make the removal deterministic.
      await waitForNextPaint();
      await waitForNextPaint();
    },
    remove() {
      if (removed) return;
      removed = true;
      observer.disconnect();
      try {
        if (typeof host.hidePopover === 'function' && host.matches(':popover-open')) host.hidePopover();
      } catch {
        // Removing the host is sufficient if its popover state changed.
      }
      host.remove();
    },
  };
}
