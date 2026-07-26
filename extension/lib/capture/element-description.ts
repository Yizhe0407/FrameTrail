import type { LateClickSuppressor } from './step-capture';

function getVisibleText(el: Element): string {
  const text = el instanceof HTMLElement ? el.innerText : el.textContent;
  const lines = text?.split('\n') ?? [];
  return (lines.find((line) => line.trim().length > 0)?.trim() ?? '').slice(0, 80);
}

function getFieldLabel(el: Element): string {
  if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement)) {
    return '';
  }
  return el.labels?.[0]?.innerText?.trim() || el.getAttribute('placeholder')?.trim() || '';
}

export function describeElement(el: Element): string {
  return (
    el.getAttribute('aria-label')?.trim() ||
    getFieldLabel(el) ||
    getVisibleText(el) ||
    el.getAttribute('title')?.trim() ||
    el.getAttribute('alt')?.trim() ||
    ''
  ).slice(0, 200);
}

export function replayElementClick(el: Element): void {
  const focus = (el as Element & { focus?: (options?: FocusOptions) => void }).focus;
  focus?.call(el, { preventScroll: true });
  const click = (el as Element & { click?: () => void }).click;
  if (typeof click === 'function') {
    click.call(el);
    return;
  }
  el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, composed: true, view: window }));
}

/** Replays a captured gesture's click with its trailing-duplicate guard armed.
 * Shared by the top-frame recorder and the child-frame relay so both ends
 * deliver exactly one page-visible click per gesture. */
export function replayClickWithSuppression(el: Element, lateClicks: LateClickSuppressor<Element>): void {
  if (!el.isConnected) return;
  // A trailing trusted click can still arrive after the gesture cleared;
  // suppress it so the page handler runs exactly once — from this replay.
  lateClicks.arm(el);
  // click() preserves control/default behavior and bubbling page click
  // handlers, but intentionally runs only after the screenshot.
  replayElementClick(el);
}
