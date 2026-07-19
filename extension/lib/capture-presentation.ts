/**
 * Capture-only styling for FrameTrail overlays and the top-level viewport
 * scrollbar. Everything stays in layout so fixed/sticky content and viewport
 * coordinates do not move while a screenshot is being composed.
 */
export const CAPTURE_PRESENTATION_CSS = `
/* FrameTrail's interaction layers are capture-only UI. Keep their hosts in
 * the document so layout and viewport coordinates remain unchanged, but make
 * them fully transparent while captureVisibleTab samples the page. */
[data-frametrail-snapshot-shield],
[data-frametrail-step-preview] {
  visibility: hidden !important;
  opacity: 0 !important;
}

:root::-webkit-scrollbar,
body::-webkit-scrollbar,
:root::-webkit-scrollbar-track,
body::-webkit-scrollbar-track,
:root::-webkit-scrollbar-track-piece,
body::-webkit-scrollbar-track-piece,
:root::-webkit-scrollbar-thumb,
body::-webkit-scrollbar-thumb,
:root::-webkit-scrollbar-button,
body::-webkit-scrollbar-button,
:root::-webkit-scrollbar-corner,
body::-webkit-scrollbar-corner,
:root::-webkit-resizer,
body::-webkit-resizer {
  background: transparent !important;
  border-color: transparent !important;
  box-shadow: none !important;
}

:root {
  scrollbar-color: transparent transparent !important;
}

:root > :not(body),
body {
  scrollbar-color: auto !important;
}

body * {
  scrollbar-color: auto;
}
`;

export interface CapturePresentationAdapter {
  insert(): Promise<void>;
  settle(): Promise<void>;
  remove(): Promise<void>;
}

/**
 * Applies capture-only presentation without exposing a half-applied state to
 * callers. Removal runs after insertion even when settling or capture fails.
 */
export async function withCapturePresentation<T>(
  adapter: CapturePresentationAdapter,
  capture: () => Promise<T>,
): Promise<T> {
  let inserted = false;
  let result: T | undefined;
  let failure: unknown;
  let failed = false;

  try {
    await adapter.insert();
    inserted = true;
    await adapter.settle();
    result = await capture();
  } catch (error) {
    failed = true;
    failure = error;
  }

  if (inserted) {
    try {
      await adapter.remove();
    } catch (restoreError) {
      if (failed) {
        throw new AggregateError([failure, restoreError], 'Capture failed and its presentation could not be restored.');
      }
      throw restoreError;
    }
  }

  if (failed) throw failure;
  return result as T;
}

/** Runs inside the captured tab through scripting.executeScript. */
export async function waitForCapturePresentationPaint(): Promise<void> {
  await new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  });
}
