import { browser } from 'wxt/browser';
import { getRecordingState } from '../../storage/storage';
import { isClickCaptureResult, requireRuntimeMessageResult } from '../../runtime/runtime-message-result';
import type { ClickCapture, ClickCaptureResult } from '../../runtime/messages';
import type { ResolvedSnapshotTarget } from '../snapshot-targeting';
import type { SnapshotShieldRect } from '../snapshot-shield-protocol';

export type CaptureSender = ReturnType<typeof createCaptureSender>;

/** The run's capture channel to the background, plus the annotation counting
 * both snapshot commit paths reconcile against. */
export function createCaptureSender(runId: string) {
  async function sendCapture(
    rect: SnapshotShieldRect,
    target: Pick<ResolvedSnapshotTarget, 'text' | 'tagName'>,
    intent: ClickCapture['intent'],
    now: number,
    captureId: string = crypto.randomUUID(),
    captureKind: ClickCapture['captureKind'] = 'element',
  ): Promise<boolean> {
    const payload: ClickCapture = {
      type: 'FRAME_TRAIL_CLICK',
      captureKind,
      captureId,
      runId,
      rect,
      devicePixelRatio: window.devicePixelRatio,
      viewport: {
        width: window.innerWidth,
        height: window.innerHeight,
        scrollX: window.scrollX,
        scrollY: window.scrollY,
      },
      text: target.text,
      tagName: target.tagName,
      intent,
      url: location.href,
      timestamp: now,
    };
    const result = requireRuntimeMessageResult<ClickCaptureResult>(
      await browser.runtime.sendMessage(payload),
      isClickCaptureResult,
      '截圖服務回應格式無效，請重新整理頁面後再試一次。',
    );
    if (result.ok) return true;
    console.warn('[frametrail] step was not captured:', result.error);
    return false;
  }

  // The background's itemCount is the single source of truth for how many
  // annotations the current snapshot holds (it resets per snapshot and moves
  // on undo/restore). Deriving labels from it keeps overlay numbering
  // correct even when a capture response is lost after the background
  // already committed the step.
  async function readAuthoritativeAnnotationCount(): Promise<number | null> {
    try {
      const state = await getRecordingState();
      return state.operation === 'recording' && state.runId === runId ? state.itemCount : null;
    } catch {
      return null;
    }
  }

  /** 回傳已提交標註的權威 1-based 編號。 */
  async function commitSnapshotAnnotation(
    rect: SnapshotShieldRect,
    target: Pick<ResolvedSnapshotTarget, 'text' | 'tagName'>,
    captureKind: ClickCapture['captureKind'],
    now: number,
  ): Promise<number | null> {
    const before = (await readAuthoritativeAnnotationCount()) ?? 0;
    try {
      if (!(await sendCapture(rect, target, 'mark', now, crypto.randomUUID(), captureKind))) return null;
      return (await readAuthoritativeAnnotationCount()) ?? before + 1;
    } catch (error) {
      // The response was lost after the background may already have
      // committed the step; the durable recording state decides which of
      // the two actually happened, so labels cannot drift off-by-one.
      console.warn('[frametrail] snapshot capture response was lost; reconciling with recording state', error);
      const after = await readAuthoritativeAnnotationCount();
      return after !== null && after > before ? after : null;
    }
  }

  return { sendCapture, readAuthoritativeAnnotationCount, commitSnapshotAnnotation };
}
