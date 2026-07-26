import { createRoot } from 'react-dom/client';
import { browser } from 'wxt/browser';
import { createRegionCapture, type RegionCapture } from '@/lib/capture/region-capture';
import RecordingToolbar from '@/components/recording/RecordingToolbar';
import {
  buildShieldTokenStorageKey,
  isSnapshotShieldTokenRecord,
  isSnapshotShieldFrameMessage,
  isSnapshotShieldInitMessage,
  SNAPSHOT_SHIELD_CANDIDATES,
  SNAPSHOT_SHIELD_CAPTURE_COMPLETE,
  SNAPSHOT_SHIELD_COMMIT,
  SNAPSHOT_SHIELD_CONTROL,
  SNAPSHOT_SHIELD_CONTROL_RESULT,
  SNAPSHOT_SHIELD_POINTER_DOWN,
  SNAPSHOT_SHIELD_POINTER_MOVE,
  SNAPSHOT_SHIELD_PREVIEW,
  SNAPSHOT_SHIELD_READY,
  SNAPSHOT_SHIELD_REGION_CAPTURE,
  SNAPSHOT_SHIELD_TOOLBAR_STATE,
  SNAPSHOT_SHIELD_UNDO,
  SNAPSHOT_TARGET_OFFSET_LIMIT,
  type SnapshotShieldKeyboardAnchor,
  type SnapshotShieldRect,
  type SnapshotShieldPortMessage,
} from '@/lib/recording/snapshot-shield-protocol';
import { SNAPSHOT_FREEZE_EVENTS } from '@/lib/recording/content-script-constants';
import type { RecordingControlMessage, RecordingControlResult } from '@/lib/runtime/messages';
import { featureFlags } from '@/lib/shared/feature-flags';
import { nextCandidateIndex } from '@/lib/capture/snapshot-candidates';
import { createOverlay } from './overlay';
import { createHoverScheduler } from './hover-scheduler';

const SHIELD_HOVER_TIMEOUT_MS = 4_000;
const SHIELD_CAPTURE_TIMEOUT_MS = 30_000;
const SHIELD_CONTROL_TIMEOUT_MS = 15_000;
const SHIELD_CHANNEL_FAILURE: RecordingControlResult = {
  ok: false,
  error: '錄製服務已中斷，請重新整理頁面後再試一次。',
};

// The shield document consumes the same freeze list as the frozen page,
// except: pointerdown feeds the annotation pipeline (its dedicated handler
// consumes selectively), and submit is handled separately because nothing in
// the shield document can host a form submission.
const FREEZE_EVENTS = SNAPSHOT_FREEZE_EVENTS.filter(
  (type) => type !== 'pointerdown' && type !== 'submit',
);

/** Distributes over the port-message union, dropping the channel token that
 * the shield page's `post` helper injects. */
type WithoutToken<M> = M extends { token: string } ? Omit<M, 'token'> : never;

// The frame URL only carries a public frame key. The secret init token is
// fetched from extension storage, which the host page cannot read (frame URLs
// leak through resource timing, so a URL-borne token would let page scripts
// race the SNAPSHOT_SHIELD_INIT handshake and hijack the channel).
const frameKey = new URL(location.href).searchParams.get('frame');
let expectedToken: string | null = null;
let initialized = false;
const MAX_PENDING_INIT_EVENTS = 8;
let pendingInitEvents: MessageEvent[] | null = [];

function consume(event: Event): void {
  if (
    event.target instanceof Element &&
    event.target.closest('[data-frametrail-shield-toolbar],[data-frametrail-shield-skip],[data-frametrail-region-capture]')
  ) {
    return;
  }
  if (event.cancelable) event.preventDefault();
  event.stopImmediatePropagation();
}

function ensureKeyboardFocus(): void {
  if (!document.hasFocus()) window.focus();
}

function tryInitialize(event: MessageEvent): void {
  const token = expectedToken;
  if (initialized || !token || event.source !== parent || !isSnapshotShieldInitMessage(event.data, token)) return;
  const port = event.ports[0];
  if (!port) return;
  initialized = true;
  const overlay = createOverlay();
  const toolbarContainer = document.createElement('div');
  toolbarContainer.setAttribute('data-frametrail-shield-toolbar', '');
  document.body.append(toolbarContainer);
  const toolbarRoot = createRoot(toolbarContainer);
  interface PendingControl {
    resolve: (result: RecordingControlResult) => void;
    timeout: ReturnType<typeof setTimeout>;
  }
  const pendingControls = new Map<number, PendingControl>();
  let channelFailed = false;
  let controlSequence = 0;
  let capturing = false;
  // Monotonic capture generation: completions and timeouts only settle the
  // capture they were armed for, never a newer one started after a timeout.
  let captureSequence = 0;
  let activeCaptureId = 0;
  let interactionsEnabled = false;
  let lastPreviewRect: SnapshotShieldRect | null = null;
  let lastCommitViaKeyboard = false;
  let keyboardAnchors: SnapshotShieldKeyboardAnchor[] = [];
  let keyboardIndex = -1;
  let focusInitialized = false;
  let regionCapture: RegionCapture | null = null;
  let pendingRegionCompletion: (() => void) | null = null;
  let lastCommitWasRegion = false;
  let captureTimeout: ReturnType<typeof setTimeout> | null = null;
  let toolbarState: import('@/components/recording/RecordingToolbar').RecordingToolbarState | null = null;

  const safePostToParent = (message: SnapshotShieldPortMessage): boolean => {
    if (channelFailed) return false;
    try {
      port.postMessage(message);
      return true;
    } catch (error) {
      console.error('[frametrail] snapshot shield channel failed', error);
      failShieldChannel();
      return false;
    }
  };
  /** Injects this page's channel token so call sites only spell out the
   * message-specific fields. */
  const post = (message: WithoutToken<SnapshotShieldPortMessage>): boolean =>
    safePostToParent({ ...message, token } as SnapshotShieldPortMessage);

  const hover = createHoverScheduler({
    isEnabled: () => interactionsEnabled,
    isCapturing: () => capturing,
    post: (request) => {
      post({ type: SNAPSHOT_SHIELD_POINTER_MOVE, ...request });
    },
    hoverTimeoutMs: SHIELD_HOVER_TIMEOUT_MS,
    offsetLimit: SNAPSHOT_TARGET_OFFSET_LIMIT,
  });

  const clearCaptureTimeout = () => {
    if (captureTimeout !== null) clearTimeout(captureTimeout);
    captureTimeout = null;
  };

  const armCaptureTimeout = (captureId: number) => {
    clearCaptureTimeout();
    captureTimeout = setTimeout(() => {
      captureTimeout = null;
      if (captureId !== activeCaptureId) return;
      capturing = false;
      lastCommitViaKeyboard = false;
      lastCommitWasRegion = false;
      pendingRegionCompletion?.();
      pendingRegionCompletion = null;
      hover.invalidateSentRevision();
      announce('擷取逾時，請重新選取目標');
      if (interactionsEnabled && !regionCapture?.isActive()) hover.schedule();
    }, SHIELD_CAPTURE_TIMEOUT_MS);
  };

  const settlePendingControl = (requestId: number, result: RecordingControlResult) => {
    const pending = pendingControls.get(requestId);
    if (!pending) return;
    pendingControls.delete(requestId);
    clearTimeout(pending.timeout);
    pending.resolve(result);
  };

  const failShieldChannel = () => {
    if (channelFailed) return;
    channelFailed = true;
    for (const requestId of pendingControls.keys()) settlePendingControl(requestId, SHIELD_CHANNEL_FAILURE);
    pendingRegionCompletion?.();
    pendingRegionCompletion = null;
    clearCaptureTimeout();
    regionCapture?.cancel('removed');
    regionCapture = null;
    capturing = false;
    interactionsEnabled = false;
    clearHover();
    resetKeyboard();
    toolbarState = null;
    renderToolbar();
  };

  const clearHover = () => {
    hover.clear();
    overlay.preview(null);
  };

  const onPointerMove = (event: PointerEvent) => {
    if (regionCapture?.isActive()) return;
    if (!interactionsEnabled) {
      clearHover();
      return;
    }
    if (event.target instanceof Element && event.target.closest('[data-frametrail-shield-toolbar]')) {
      clearHover();
      return;
    }
    ensureKeyboardFocus();
    hover.pointerMove(event.clientX, event.clientY);
  };

  const commitAt = (clientX: number, clientY: number, viaKeyboard: boolean) => {
    if (!interactionsEnabled || capturing) return;
    capturing = true;
    activeCaptureId = ++captureSequence;
    lastCommitViaKeyboard = viaKeyboard;
    const candidateOffset = hover.beginCapture(clientX, clientY);
    overlay.preview(null);
    lastPreviewRect = null;
    armCaptureTimeout(activeCaptureId);
    const posted = post({
      type: SNAPSHOT_SHIELD_POINTER_DOWN,
      captureId: activeCaptureId,
      clientX,
      clientY,
      candidateOffset,
    });
    if (!posted) clearCaptureTimeout();
  };

  const onPointerDown = (event: PointerEvent) => {
    if (regionCapture?.isActive()) return;
    if (
      event.target instanceof Element &&
      event.target.closest('[data-frametrail-shield-toolbar],[data-frametrail-shield-skip],[data-frametrail-region-capture]')
    ) {
      return;
    }
    consume(event);
    ensureKeyboardFocus();
    if (!interactionsEnabled || capturing || event.button !== 0 || !event.isPrimary) return;
    commitAt(event.clientX, event.clientY, false);
  };

  const onCandidateKeyDown = (event: KeyboardEvent) => {
    if (regionCapture?.isActive()) return;
    if (event.target instanceof Element && event.target.closest('[data-frametrail-shield-toolbar]')) return;
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
    consume(event);
    if (!interactionsEnabled || capturing || !hover.hasPoint()) return;
    hover.adjustOffset(event.key === 'ArrowUp' ? 1 : -1);
  };

  // Keyboard-only annotation traversal (§9.5). Roving over the parent-supplied
  // candidate anchors reuses the same probe/preview/commit engine as pointing.
  let liveRegion: HTMLElement | null = null;
  let skipLink: HTMLButtonElement | null = null;

  const announce = (message: string) => {
    if (liveRegion) liveRegion.textContent = message;
  };

  const focusToolbar = () => {
    const control = toolbarContainer.querySelector<HTMLElement>('button, [tabindex]');
    control?.focus();
  };

  const sendShieldControl = (
    action: RecordingControlMessage['type'],
    undoToken?: string,
  ): Promise<RecordingControlResult> => {
    const requestId = ++controlSequence;
    return new Promise<RecordingControlResult>((resolve) => {
      const timeout = setTimeout(
        () => settlePendingControl(requestId, SHIELD_CHANNEL_FAILURE),
        SHIELD_CONTROL_TIMEOUT_MS,
      );
      pendingControls.set(requestId, { resolve, timeout });
      const posted = post({
        type: SNAPSHOT_SHIELD_CONTROL,
        requestId,
        action,
        ...(undoToken ? { undoToken } : {}),
      });
      if (!posted) settlePendingControl(requestId, SHIELD_CHANNEL_FAILURE);
    });
  };

  const renderToolbar = () => {
    const state = toolbarState;
    toolbarRoot.render(
      state && (state.phase === 'recording' || state.phase === 'invalidated' || state.phase === 'finishing') ? (
        <RecordingToolbar
          state={state}
          onCommand={(action: RecordingControlMessage['type'], undoToken?: string) =>
            sendShieldControl(action, undoToken)
          }
          onStartRegionCapture={() => startRegionCapture()}
          regionCaptureActive={regionCapture?.isActive() ?? false}
        />
      ) : null,
    );
  };

  const startRegionCapture = () => {
    if (!interactionsEnabled || capturing || regionCapture?.isActive()) return;
    clearHover();
    resetKeyboard();
    document.body.classList.add('has-region-capture');
    const controller = createRegionCapture({
      settleFrames: 0,
      onCapture: async (rect) => {
        if (!interactionsEnabled || capturing) return;
        capturing = true;
        activeCaptureId = ++captureSequence;
        lastCommitWasRegion = true;
        await new Promise<void>((resolve) => {
          pendingRegionCompletion = resolve;
          armCaptureTimeout(activeCaptureId);
          const posted = post({
            type: SNAPSHOT_SHIELD_REGION_CAPTURE,
            captureId: activeCaptureId,
            rect,
          });
          if (!posted) clearCaptureTimeout();
        });
      },
      onCancel: () => {
        pendingRegionCompletion?.();
        pendingRegionCompletion = null;
        clearCaptureTimeout();
        lastCommitWasRegion = false;
        capturing = false;
      },
      onClose: () => {
        if (regionCapture === controller) regionCapture = null;
        document.body.classList.remove('has-region-capture');
        renderToolbar();
        if (interactionsEnabled && !capturing) hover.schedule();
      },
    });
    regionCapture = controller;
    renderToolbar();
  };

  const roveTo = (delta: number) => {
    if (!keyboardAnchors.length) {
      announce('目前沒有可用鍵盤標註的元素');
      return;
    }
    // Leave the skip link so Enter commits the candidate instead of being read
    // as the skip link's own activation; the iframe keeps document focus.
    if (skipLink && document.activeElement === skipLink) skipLink.blur();
    keyboardIndex = nextCandidateIndex(keyboardIndex, keyboardAnchors.length, delta);
    const anchor = keyboardAnchors[keyboardIndex];
    hover.setAnchor(anchor.x, anchor.y);
    announce(`候選 ${keyboardIndex + 1} / ${keyboardAnchors.length}：${anchor.label || '未命名元素'}`);
  };

  const commitCurrent = () => {
    if (keyboardIndex < 0 || keyboardIndex >= keyboardAnchors.length) return;
    if (lastPreviewRect === null) {
      announce('此處無法標註，請選擇其他元素');
      return;
    }
    const anchor = keyboardAnchors[keyboardIndex];
    commitAt(anchor.x, anchor.y, true);
  };

  const resetKeyboard = () => {
    keyboardIndex = -1;
  };

  // Unlike consume(), this always prevents the default. The keys handled here
  // are fully owned by the traversal, so even when the skip link is focused
  // (exempt from consume) their native behaviour must not also fire.
  const stopEvent = (event: Event) => {
    if (event.cancelable) event.preventDefault();
    event.stopImmediatePropagation();
  };

  const onShieldKeyDown = (event: KeyboardEvent) => {
    // The region controller is registered later on the same capture target; do
    // not let keyboard traversal consume Escape before the controller sees it.
    if (regionCapture?.isActive()) return;
    if (!featureFlags.snapshotKeyboardNav) return;
    const target = event.target;
    if (target instanceof Element && target.closest('[data-frametrail-shield-toolbar]')) return;
    if (event.key === 'Escape') {
      if (!skipLink) return;
      stopEvent(event);
      resetKeyboard();
      overlay.preview(null);
      skipLink.focus();
      return;
    }
    if (!interactionsEnabled || capturing) return;
    const inSkip = target instanceof Element && target.closest('[data-frametrail-shield-skip]');
    switch (event.key) {
      case 'Tab':
        stopEvent(event);
        roveTo(event.shiftKey ? -1 : 1);
        return;
      case 'Enter':
      case ' ':
      case 'Spacebar':
        // Let a focused skip link activate natively (jump to controls).
        if (inSkip) return;
        stopEvent(event);
        commitCurrent();
        return;
      case 'Delete':
      case 'Backspace':
        stopEvent(event);
        void sendShieldControl('UNDO_LAST_CAPTURE');
        return;
    }
  };

  if (featureFlags.snapshotKeyboardNav) {
    const skipContainer = document.createElement('div');
    skipContainer.setAttribute('data-frametrail-shield-skip', '');
    skipLink = document.createElement('button');
    skipLink.type = 'button';
    skipLink.className = 'snapshot-skip-link';
    skipLink.textContent = '跳至錄製控制';
    skipLink.addEventListener('click', () => focusToolbar());
    skipContainer.append(skipLink);
    document.body.append(skipContainer);

    liveRegion = document.createElement('div');
    liveRegion.className = 'snapshot-live-region';
    liveRegion.setAttribute('role', 'status');
    liveRegion.setAttribute('aria-live', 'polite');
    document.body.append(liveRegion);
  }

  port.onmessage = (event) => {
    if (!isSnapshotShieldFrameMessage(event.data, token)) return;
    if (event.data.type === SNAPSHOT_SHIELD_PREVIEW) {
      const outcome = hover.resolvePreview({
        requestId: event.data.requestId,
        candidateOffset: event.data.candidateOffset,
      });
      if (outcome === 'ignored') return;
      if (outcome === 'accepted') {
        lastPreviewRect = event.data.rect;
        overlay.preview(event.data.rect);
      }
      hover.schedule();
      return;
    }
    if (event.data.type === SNAPSHOT_SHIELD_CANDIDATES) {
      keyboardAnchors = event.data.anchors;
      keyboardIndex = -1;
      return;
    }
    if (event.data.type === SNAPSHOT_SHIELD_COMMIT) {
      overlay.commit(event.data.selection);
      return;
    }
    if (event.data.type === SNAPSHOT_SHIELD_UNDO) {
      overlay.undo();
      return;
    }
    if (event.data.type === SNAPSHOT_SHIELD_TOOLBAR_STATE) {
      const state = event.data.state;
      toolbarState = state;
      interactionsEnabled = state.phase === 'recording';
      if (!interactionsEnabled) {
        regionCapture?.cancel(state.phase === 'invalidated' ? 'viewport' : 'removed');
        capturing = false;
        clearCaptureTimeout();
        clearHover();
        resetKeyboard();
      }
      renderToolbar();
      // Land keyboard users on the skip link once, so the first Tab enters the
      // candidate list rather than being swallowed by the frozen page.
      if (interactionsEnabled && !focusInitialized && skipLink) {
        focusInitialized = true;
        skipLink.focus({ preventScroll: true });
      }
      return;
    }
    if (event.data.type === SNAPSHOT_SHIELD_CONTROL_RESULT) {
      settlePendingControl(event.data.requestId, event.data.result);
      return;
    }
    if (event.data.type === SNAPSHOT_SHIELD_CAPTURE_COMPLETE) {
      if (event.data.captureId !== activeCaptureId || !capturing) {
        // A stale completion — its local timeout already fired, or a newer
        // capture owns the flow. Its annotation may still be committed to the
        // overlay, but it must not settle the current capture and above all
        // must not run a pendingRegionCompletion it does not own.
        if (event.data.selection) overlay.commit(event.data.selection);
        return;
      }
      if (event.data.selection) {
        overlay.commit(event.data.selection);
        if (lastCommitWasRegion) {
          const label = event.data.selection.label;
          announce(label !== null ? `已加入區域標註 ${label}` : '已加入區域標註');
        } else if (lastCommitViaKeyboard) {
          const label = event.data.selection.label;
          announce(label !== null ? `已加入標註 ${label}` : '已加入標註');
        }
      } else if (lastCommitWasRegion) {
        announce('未建立區域標註，請重新拖曳');
      } else if (lastCommitViaKeyboard) {
        announce('未建立標註，請再選一次');
      }
      lastCommitViaKeyboard = false;
      lastCommitWasRegion = false;
      capturing = false;
      clearCaptureTimeout();
      pendingRegionCompletion?.();
      pendingRegionCompletion = null;
      hover.invalidateSentRevision();
      if (interactionsEnabled && !regionCapture?.isActive()) hover.schedule();
    }
  };

  window.addEventListener('pointermove', onPointerMove, { capture: true, passive: true });
  window.addEventListener('pointerout', (event) => {
    if (!event.relatedTarget) clearHover();
  }, { capture: true });
  window.addEventListener('pointerdown', onPointerDown, { capture: true, passive: false });
  window.addEventListener('keydown', onShieldKeyDown, { capture: true, passive: false });
  window.addEventListener('keydown', onCandidateKeyDown, { capture: true, passive: false });
  for (const type of FREEZE_EVENTS) {
    window.addEventListener(type, consume, { capture: true, passive: false });
  }
  window.addEventListener('resize', () => {
    // A resize invalidates both hit targets and the collision layout.
    regionCapture?.cancel('viewport');
    clearHover();
    overlay.relayout();
  });
  port.onmessageerror = failShieldChannel;
  port.start();

  post({ type: SNAPSHOT_SHIELD_READY });
}

window.addEventListener('message', (event) => {
  if (initialized) return;
  if (expectedToken === null) {
    // Init can arrive before the token read resolves; keep a bounded buffer
    // of parent-sourced candidates and replay them once the token is known.
    if (pendingInitEvents && event.source === parent && pendingInitEvents.length < MAX_PENDING_INIT_EVENTS) {
      pendingInitEvents.push(event);
    }
    return;
  }
  tryInitialize(event);
});

void (async () => {
  if (!frameKey) return;
  const storageKey = buildShieldTokenStorageKey(frameKey);
  try {
    const stored = await browser.storage.local.get(storageKey);
    const record = stored[storageKey];
    // Single use: consume the record immediately so it cannot be replayed.
    void browser.storage.local.remove(storageKey).catch(() => undefined);
    if (!isSnapshotShieldTokenRecord(record)) return;
    expectedToken = record.token;
  } catch (error) {
    console.error('[frametrail] failed to load the snapshot shield init token', error);
    return;
  }
  const queued = pendingInitEvents ?? [];
  pendingInitEvents = null;
  for (const event of queued) {
    if (initialized) break;
    tryInitialize(event);
  }
})();
