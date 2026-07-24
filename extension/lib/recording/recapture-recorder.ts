import { browser } from 'wxt/browser';
import {
  CLEANUP_EVENT,
  resolveSnapshotTargetAtPoint,
} from './snapshot-targeting';
import { startKeepAlive } from '../runtime/keep-alive';
import { deepElementFromPoint, getComposedParent } from '../capture/selector-utils';
import { createStepPreview } from '../capture/step-preview';
import {
  isInScrollableElementGutter,
  isInScrollbarGutter,
} from './recording-guards';
import { getRecordingState, onRecordingStateChange } from '../storage/storage';
import { createLatestAsyncRequestRunner } from '../capture/frame-probe';
import {
  isRuntimeBoolean,
  isStepRecaptureTargetResult,
  requireRuntimeMessageResult,
} from '../runtime/runtime-message-result';
import type {
  FrameTrailRecaptureTargetMessage,
  FrameTrailStopMessage,
  StepRecaptureContext,
  StepRecaptureTargetResult,
} from '../runtime/messages';
import {
  CONTENT_KEEPALIVE_INTERVAL_MS,
  CONTENT_KEEPALIVE_PORT_NAME,
  STEP_FOLLOWUP_EVENTS,
} from './content-script-constants';

function createRecaptureToolbar(onCancel: () => void): { host: HTMLElement; remove(): void } {
  const host = document.createElement('div');
  host.setAttribute('data-frametrail-recording-toolbar', '');
  host.style.setProperty('all', 'initial', 'important');
  host.style.setProperty('position', 'fixed', 'important');
  host.style.setProperty('top', '16px', 'important');
  host.style.setProperty('left', '50%', 'important');
  host.style.setProperty('transform', 'translateX(-50%)', 'important');
  host.style.setProperty('z-index', '2147483647', 'important');
  const root = host.attachShadow({ mode: 'closed' });
  const wrapper = document.createElement('div');
  wrapper.setAttribute('role', 'status');
  wrapper.style.cssText = [
    'all:initial',
    'display:flex',
    'align-items:center',
    'gap:12px',
    'padding:10px 12px',
    'border:1px solid rgba(255,255,255,.18)',
    'border-radius:12px',
    'background:#111827',
    'box-shadow:0 12px 32px rgba(0,0,0,.35)',
    'color:#f9fafb',
    'font:600 14px/1.3 system-ui,sans-serif',
  ].join(';');
  const label = document.createElement('span');
  label.textContent = '請選取要補拍的目標（Esc 取消）';
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.textContent = '取消';
  cancel.style.cssText = [
    'all:initial',
    'cursor:pointer',
    'padding:7px 10px',
    'border-radius:8px',
    'background:#374151',
    'color:#fff',
    'font:600 14px/1 system-ui,sans-serif',
  ].join(';');
  cancel.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    onCancel();
  });
  wrapper.append(label, cancel);
  root.append(wrapper);
  document.documentElement.append(host);
  return { host, remove: () => host.remove() };
}

export async function installRecaptureRecorder(context: StepRecaptureContext): Promise<void> {
  const runId = context.runId;
  let active = false;
  let busy = false;
  let removed = false;
  let hoverVersion = 0;

  const preview = createStepPreview();
  const keepAlive = startKeepAlive(browser.runtime, {
    name: CONTENT_KEEPALIVE_PORT_NAME,
    intervalMs: CONTENT_KEEPALIVE_INTERVAL_MS,
  });

  const cancelWorkflow = () => {
    if (removed) return;
    void browser.runtime.sendMessage({ type: 'CANCEL_STEP_RECAPTURE', runId }).catch((error) => {
      console.error('[frametrail] failed to cancel recapture', error);
    });
  };
  const toolbar = createRecaptureToolbar(cancelWorkflow);

  const hoverProbe = createLatestAsyncRequestRunner(
    async (point: { clientX: number; clientY: number; version: number }) => {
      if (removed || !active || busy) return;
      const target = await resolveSnapshotTargetAtPoint(runId, point.clientX, point.clientY);
      if (removed || !active || busy || point.version !== hoverVersion) return;
      if (target) preview.show(target.rect);
      else preview.hide();
    },
    (error) => {
      if (!removed && active) preview.hide();
      console.warn('[frametrail] failed to preview recapture target', error);
    },
  );

  const onPointerMove = (event: PointerEvent) => {
    if (!active || busy || toolbar.host === event.target || toolbar.host.contains(event.target as Node)) return;
    hoverProbe.submit({
      clientX: event.clientX,
      clientY: event.clientY,
      version: ++hoverVersion,
    });
  };

  const onPointerDown = (event: PointerEvent) => {
    if (event.button !== 0 || !event.isPrimary) return;
    if (event.composedPath().includes(toolbar.host)) return;
    if (isInScrollbarGutter(event.clientX, event.clientY, document.documentElement)) return;
    const hit = deepElementFromPoint(event.clientX, event.clientY);
    let gutterAncestor = hit;
    while (gutterAncestor) {
      if (isInScrollableElementGutter(event.clientX, event.clientY, gutterAncestor)) return;
      gutterAncestor = getComposedParent(gutterAncestor);
    }
    if (!active || busy) {
      event.preventDefault();
      event.stopImmediatePropagation();
      return;
    }

    // This gesture only selects a capture target. It is never replayed into the
    // page, regardless of success, cancellation or screenshot failure.
    event.preventDefault();
    event.stopImmediatePropagation();
    busy = true;
    hoverVersion++;
    hoverProbe.clearPending();
    const clientX = event.clientX;
    const clientY = event.clientY;
    void (async () => {
      const target = await resolveSnapshotTargetAtPoint(runId, clientX, clientY);
      if (!target || removed) {
        busy = false;
        return;
      }
      await preview.prepareForCapture();
      if (removed) return;
      const captureId = crypto.randomUUID();
      const payload: FrameTrailRecaptureTargetMessage = {
        type: 'FRAME_TRAIL_RECAPTURE_TARGET',
        runId,
        captureId,
        rect: target.rect,
        viewport: {
          width: window.innerWidth,
          height: window.innerHeight,
          scrollX: window.scrollX,
          scrollY: window.scrollY,
        },
        devicePixelRatio: window.devicePixelRatio,
        url: location.href,
        timestamp: Date.now(),
      };
      try {
        const result = requireRuntimeMessageResult<StepRecaptureTargetResult>(
          await browser.runtime.sendMessage(payload),
          isStepRecaptureTargetResult,
          '補拍服務回應格式無效，請重新整理頁面後再試一次。',
        );
        if (!result.ok && result.status === 'rejected' && !removed) {
          busy = false;
          preview.show(target.rect);
        }
      } catch (error) {
        console.error('[frametrail] recapture target failed', error);
        cancelWorkflow();
      }
    })();
  };

  const onFollowup = (event: Event) => {
    if (!busy) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    event.stopImmediatePropagation();
    cancelWorkflow();
  };
  let unsubscribe = () => {};
  const onStop = (message: FrameTrailStopMessage) => {
    if (message?.type === 'FRAME_TRAIL_STOP') cleanup();
  };
  function cleanup() {
    if (removed) return;
    removed = true;
    active = false;
    hoverProbe.clearPending();
    preview.remove();
    toolbar.remove();
    window.removeEventListener('pointermove', onPointerMove, { capture: true });
    document.removeEventListener('pointerdown', onPointerDown, { capture: true });
    for (const type of STEP_FOLLOWUP_EVENTS) document.removeEventListener(type, onFollowup, { capture: true });
    window.removeEventListener('keydown', onKeyDown, { capture: true });
    document.removeEventListener(CLEANUP_EVENT, cleanup);
    browser.runtime.onMessage.removeListener(onStop);
    unsubscribe();
    keepAlive.stop();
  }
  unsubscribe = onRecordingStateChange((state) => {
    if (state.operation !== 'recapture' || state.recapture?.runId !== runId) cleanup();
    else {
      active = state.recapture.phase === 'awaiting-target';
      if (!active) {
        hoverVersion += 1;
        hoverProbe.clearPending();
        preview.hide();
      }
    }
  });

  window.addEventListener('pointermove', onPointerMove, { capture: true, passive: true });
  document.addEventListener('pointerdown', onPointerDown, { capture: true });
  for (const type of STEP_FOLLOWUP_EVENTS) document.addEventListener(type, onFollowup, { capture: true });
  window.addEventListener('keydown', onKeyDown, { capture: true });
  document.addEventListener(CLEANUP_EVENT, cleanup);
  browser.runtime.onMessage.addListener(onStop);

  let ready = false;
  try {
    ready = requireRuntimeMessageResult(
      await browser.runtime.sendMessage({
        type: 'FRAME_TRAIL_RECAPTURE_READY',
        runId,
        url: location.href,
      }),
      isRuntimeBoolean,
      '補拍服務回應格式無效，請重新整理頁面後再試一次。',
    );
  } catch (error) {
    console.error('[frametrail] recapture readiness check failed', error);
  }
  if (!ready || removed) {
    cleanup();
    return;
  }
  // The durable phase change may land immediately after the ready response.
  // Storage subscription is authoritative; this read closes the tiny gap when
  // the change event fired before the listener was installed.
  const latest = await getRecordingState();
  active = latest.operation === 'recapture' && latest.recapture?.runId === runId && latest.recapture.phase === 'awaiting-target';
}
