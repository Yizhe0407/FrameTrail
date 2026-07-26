import { createStepPreview } from '../capture/step-preview';
import {
  getComposedParent,
  getVisibleHighlightBounds,
  resolvePrimaryVisualTarget,
} from '../capture/selector-utils';
import { isPointInsideViewport } from './recording-guards';

const STEP_PREVIEW_FALLBACK_MS = 750;

export interface StepHoverPreviewOptions {
  isPaused(): boolean;
  /** True while a step gesture's capture is in flight; the preview must stay
   * hidden until the screenshot lands. */
  isGestureActive(): boolean;
  isRegionCaptureActive(): boolean;
}

export interface StepHoverPreviewHandlers {
  onPointerMove(event: PointerEvent): void;
  onPointerOut(event: PointerEvent): void;
  onPointerLeave(event: PointerEvent): void;
  onVisibilityChange(): void;
}

export interface StepHoverPreview {
  /** Event handlers the owner wires to window/document; kept explicit so the
   * recorder's lifecycle spine stays in charge of listener registration. */
  handlers: StepHoverPreviewHandlers;
  /** Coalesces a re-render of the hover highlight onto the next frame. */
  schedule(): void;
  /** Arms the periodic fallback re-render for pages that mutate without
   * emitting any of the scheduled events. */
  armFallback(): void;
  /** Hides the highlight and stops all scheduled work (pause, gesture start,
   * region capture) without dropping the last pointer position's observer. */
  suspend(): void;
  /** Hides the highlight and settles paints before a screenshot. */
  prepareForCapture(): Promise<void>;
  /** Tears down the preview element, observer, and timers. */
  destroy(): void;
}

/**
 * Owns the step-mode hover highlight: pointer tracking, frame-coalesced
 * rendering, a mutation observer bounded to the hovered target's composed
 * ancestor chain, and a slow fallback timer for silent DOM churn.
 */
export function createStepHoverPreview(options: StepHoverPreviewOptions): StepHoverPreview {
  const preview = createStepPreview();
  let frame: number | null = null;
  let point: { clientX: number; clientY: number } | null = null;
  let observedTarget: Element | null = null;
  let fallbackTimer: ReturnType<typeof setTimeout> | null = null;
  const observer = new MutationObserver(() => schedule());

  const disconnectObserver = () => {
    observer.disconnect();
    observedTarget = null;
  };

  const observeTarget = (target: Element | null) => {
    if (target === observedTarget) return;
    disconnectObserver();
    if (!target) return;

    const observedNodes = new Map<Node, MutationObserverInit>();
    const mergeOptions = (node: Node, mergeInit: MutationObserverInit) => {
      const current = observedNodes.get(node) ?? {};
      observedNodes.set(node, {
        childList: current.childList || mergeInit.childList,
        attributes: current.attributes || mergeInit.attributes,
        characterData: current.characterData || mergeInit.characterData,
        subtree: current.subtree || mergeInit.subtree,
        ...(current.attributes || mergeInit.attributes
          ? { attributeFilter: ['class', 'style', 'hidden', 'aria-hidden'] }
          : {}),
      });
    };

    // Observe content/style changes inside the selected target, direct child
    // replacement in its DOM parent, and only style-affecting attributes on
    // composed ancestors. Unrelated document subtrees produce no records.
    mergeOptions(target, { subtree: true, childList: true, attributes: true, characterData: true });
    if (target.parentNode) mergeOptions(target.parentNode, { childList: true });
    let ancestor = getComposedParent(target);
    while (ancestor) {
      // Direct child replacement on any composed ancestor can detach the
      // current target (for example a virtualized row replacing its wrapper).
      // This remains bounded to the ancestor chain; no document subtree is
      // observed.
      mergeOptions(ancestor, { attributes: true, childList: true });
      ancestor = getComposedParent(ancestor);
    }
    for (const [node, init] of observedNodes) observer.observe(node, init);
    observedTarget = target;
  };

  const stopFallback = () => {
    if (fallbackTimer !== null) clearTimeout(fallbackTimer);
    fallbackTimer = null;
  };

  const armFallback = () => {
    // Hidden tabs get no frames, so the timer would spin without ever
    // rendering; visibilitychange re-arms it when the tab returns.
    if (document.visibilityState === 'hidden') return;
    if (options.isPaused() || !point || options.isGestureActive() || fallbackTimer !== null) return;
    fallbackTimer = setTimeout(() => {
      fallbackTimer = null;
      schedule();
      armFallback();
    }, STEP_PREVIEW_FALLBACK_MS);
  };

  const render = () => {
    frame = null;
    if (options.isPaused() || !point || options.isGestureActive()) {
      disconnectObserver();
      preview.hide();
      return;
    }
    const { clientX, clientY } = point;
    const target = resolvePrimaryVisualTarget(clientX, clientY);
    const bounds = target ? getVisibleHighlightBounds(target, clientX, clientY) : null;
    observeTarget(target);
    if (bounds) preview.show(bounds);
    else preview.hide();
    armFallback();
  };

  const schedule = () => {
    if (!point || options.isGestureActive() || frame !== null) return;
    frame = requestAnimationFrame(render);
  };

  const suspend = () => {
    if (frame !== null) cancelAnimationFrame(frame);
    frame = null;
    disconnectObserver();
    stopFallback();
    preview.hide();
  };

  const onPointerMove = (event: PointerEvent) => {
    if (options.isPaused() || options.isRegionCaptureActive()) return;
    point = { clientX: event.clientX, clientY: event.clientY };
    schedule();
    armFallback();
  };

  const onPointerOut = (event: PointerEvent) => {
    if (event.relatedTarget) return;
    if (
      isPointInsideViewport(event.clientX, event.clientY, {
        width: window.innerWidth,
        height: window.innerHeight,
      })
    ) {
      // Virtualized pages can detach the old target during scroll and emit a
      // null-relatedTarget pointerout even though the cursor never left the
      // viewport. Keep the point and resolve whatever moved underneath it.
      schedule();
      return;
    }
    point = null;
    suspend();
  };

  const onPointerLeave = (event: PointerEvent) => {
    if (event.relatedTarget) return;
    point = null;
    suspend();
  };

  const onVisibilityChange = () => {
    if (document.visibilityState === 'hidden') {
      stopFallback();
      return;
    }
    if (options.isPaused()) return;
    schedule();
    armFallback();
  };

  return {
    handlers: { onPointerMove, onPointerOut, onPointerLeave, onVisibilityChange },
    schedule,
    armFallback,
    suspend,
    prepareForCapture: () => preview.prepareForCapture(),
    destroy() {
      if (frame !== null) cancelAnimationFrame(frame);
      frame = null;
      disconnectObserver();
      stopFallback();
      preview.remove();
    },
  };
}
