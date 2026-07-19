import type { ClickCapture, RecordingMode, RecordingState } from './messages';

export type CaptureGuardFailure = 'stale-run' | 'inactive-tab' | 'changed-url' | null;
export type RecordingTabUpdateAction = 'ignore' | 'reinject' | 'stop-snapshot';

/**
 * True when a pointer coordinate falls in a native scrollbar gutter. The layout
 * viewport (`clientWidth`/`clientHeight`) excludes the scrollbars, so anything at
 * or beyond it is a scroll gesture on the bar — never page content. Step mode must
 * leave those events alone so the user can still drag to scroll and no bogus step
 * is recorded from a hit-test that lands on nothing.
 */
export function isInScrollbarGutter(
  clientX: number,
  clientY: number,
  layout: { clientLeft: number; clientTop: number; clientWidth: number; clientHeight: number },
): boolean {
  const right = layout.clientLeft + layout.clientWidth;
  const bottom = layout.clientTop + layout.clientHeight;
  return clientX < layout.clientLeft || clientX >= right || clientY < layout.clientTop || clientY >= bottom;
}

/** True when a point lands in a native scrollbar belonging to a nested
 * overflow element. The element's client box excludes its scrollbar gutter,
 * while its border box includes it; comparing the two preserves scrolling even
 * when the page itself has no root scrollbar. */
export function isInScrollableElementGutter(clientX: number, clientY: number, element: Element): boolean {
  if (!(element instanceof HTMLElement)) return false;
  const rect = element.getBoundingClientRect();
  if (clientX < rect.left || clientX >= rect.right || clientY < rect.top || clientY >= rect.bottom) return false;
  const style = getComputedStyle(element);
  const overflowX = style.overflowX || style.overflow;
  const overflowY = style.overflowY || style.overflow;
  const scrollsX = ['auto', 'scroll', 'overlay'].includes(overflowX) && element.scrollWidth > element.clientWidth;
  const scrollsY = ['auto', 'scroll', 'overlay'].includes(overflowY) && element.scrollHeight > element.clientHeight;
  if (!scrollsX && !scrollsY) return false;

  const scaleX = rect.width / (element.offsetWidth || rect.width || 1);
  const scaleY = rect.height / (element.offsetHeight || rect.height || 1);
  const contentLeft = rect.left + element.clientLeft * scaleX;
  const contentTop = rect.top + element.clientTop * scaleY;
  const contentRight = contentLeft + element.clientWidth * scaleX;
  const contentBottom = contentTop + element.clientHeight * scaleY;
  return (
    // A vertical scrollbar consumes horizontal space and a horizontal
    // scrollbar consumes vertical space.
    (scrollsY && (clientX < contentLeft || clientX >= contentRight)) ||
    (scrollsX && (clientY < contentTop || clientY >= contentBottom))
  );
}

/** A null-relatedTarget pointerout can be synthesized when scrolling or DOM
 * replacement moves the old target out from under a stationary cursor. It only
 * means the pointer left the page when its coordinates also left the viewport. */
export function isPointInsideViewport(
  clientX: number,
  clientY: number,
  viewport: { width: number; height: number },
): boolean {
  return clientX >= 0 && clientY >= 0 && clientX < viewport.width && clientY < viewport.height;
}

export function getRecordingTabUpdateAction(
  mode: RecordingMode,
  changeInfo: { status?: string; url?: string },
): RecordingTabUpdateAction {
  if (mode === 'snapshot') {
    return changeInfo.status === 'loading' || Boolean(changeInfo.url) ? 'stop-snapshot' : 'ignore';
  }
  return changeInfo.status === 'complete' ? 'reinject' : 'ignore';
}

export function getCaptureGuardFailure(input: {
  expectedControlVersion: number;
  currentControlVersion: number;
  runId: string;
  sessionId: string;
  tabId: number;
  expectedUrl: string;
  state: RecordingState;
  activeTab: { id?: number; url?: string } | undefined;
}): CaptureGuardFailure {
  const { state } = input;
  if (
    input.expectedControlVersion !== input.currentControlVersion ||
    !state.isRecording ||
    state.runId !== input.runId ||
    state.sessionId !== input.sessionId ||
    state.tabId !== input.tabId
  ) {
    return 'stale-run';
  }
  if (input.activeTab?.id !== input.tabId) return 'inactive-tab';
  if (input.activeTab.url && input.activeTab.url !== input.expectedUrl) return 'changed-url';
  return null;
}

export function isMatchingSnapshotViewport(
  expected: ClickCapture['viewport'],
  expectedDevicePixelRatio: number,
  actual: ClickCapture['viewport'],
  actualDevicePixelRatio: number,
): boolean {
  return (
    expected.width === actual.width &&
    expected.height === actual.height &&
    Math.abs(expected.scrollX - actual.scrollX) < 1 &&
    Math.abs(expected.scrollY - actual.scrollY) < 1 &&
    expectedDevicePixelRatio === actualDevicePixelRatio
  );
}
