import { createRoot } from 'react-dom/client';
import { createRegionCapture, type RegionCapture } from '@/lib/capture/region-capture';
import RecordingToolbar from '@/components/recording/RecordingToolbar';
import {
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
  type SnapshotShieldPointerDownMessage,
  type SnapshotShieldPointerMoveMessage,
  type SnapshotShieldReadyMessage,
  type SnapshotShieldRegionCaptureMessage,
  type SnapshotShieldRect,
  type SnapshotShieldSelection,
  type SnapshotShieldControlMessage,
  type SnapshotShieldPortMessage,
} from '@/lib/recording/snapshot-shield-protocol';
import type { RecordingControlMessage, RecordingControlResult } from '@/lib/runtime/messages';
import { featureFlags } from '@/lib/shared/feature-flags';
import { nextCandidateIndex } from '@/lib/capture/snapshot-candidates';
import {
  BADGE_RADIUS,
  HIGHLIGHT_LINE_WIDTH,
  HIGHLIGHT_RADIUS,
  LEADER_LINE_WIDTH,
  MARKER_INNER_RADIUS,
  MARKER_RADIUS,
  MARKER_RING_WIDTH,
  fitHighlightFrame,
  getBadgeFontSize,
  layoutAnnotations,
} from '@/lib/media/annotate';

const SHIELD_HOVER_TIMEOUT_MS = 4_000;
const SHIELD_CAPTURE_TIMEOUT_MS = 30_000;
const SHIELD_CONTROL_TIMEOUT_MS = 15_000;
const SHIELD_CHANNEL_FAILURE: RecordingControlResult = {
  ok: false,
  error: '錄製服務已中斷，請重新整理頁面後再試一次。',
};

const FREEZE_EVENTS = [
  'pointerup',
  'pointercancel',
  'mousedown',
  'mouseup',
  'click',
  'dblclick',
  'auxclick',
  'contextmenu',
  'keydown',
  'keyup',
  'keypress',
  'beforeinput',
  'input',
  'wheel',
  'touchstart',
  'touchmove',
  'touchend',
  'dragstart',
  'drop',
  'selectstart',
] as const;

const token = new URL(location.href).searchParams.get('token');
let initialized = false;

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

function positionBox(element: HTMLElement, rect: SnapshotShieldRect): void {
  const frame = fitHighlightFrame(rect, window.innerWidth, window.innerHeight);
  element.style.left = `${frame.x}px`;
  element.style.top = `${frame.y}px`;
  element.style.width = `${frame.width}px`;
  element.style.height = `${frame.height}px`;
}

function createOverlay() {
  const root = document.createElement('div');
  root.className = 'snapshot-overlay';
  root.setAttribute('aria-hidden', 'true');

  const committedLayer = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  committedLayer.setAttribute('class', 'snapshot-overlay__committed');
  const leaderLayer = document.createElementNS('http://www.w3.org/2000/svg', 'g');
  const targetLayer = document.createElementNS('http://www.w3.org/2000/svg', 'g');
  const badgeLayer = document.createElementNS('http://www.w3.org/2000/svg', 'g');
  committedLayer.append(leaderLayer, targetLayer, badgeLayer);
  const preview = document.createElement('div');
  preview.className = 'snapshot-box snapshot-box--preview';
  preview.hidden = true;
  root.append(committedLayer, preview);
  document.body.append(root);

  const committedIds = new Set<number>();
  const committedSelections: Array<SnapshotShieldSelection & { id: number }> = [];
  const committedRectKeys = new Set<string>();

  const rectKey = (rect: SnapshotShieldRect) =>
    [rect.x, rect.y, rect.width, rect.height].map((value) => Math.round(value * 2)).join(':');

  const svgElement = <K extends keyof SVGElementTagNameMap>(name: K): SVGElementTagNameMap[K] =>
    document.createElementNS('http://www.w3.org/2000/svg', name);

  interface AnnotationElements {
    leader: SVGGElement;
    target: SVGGElement;
    badge: SVGGElement;
  }

  const elementsById = new Map<number, AnnotationElements>();
  const setAttribute = (element: Element, name: string, value: string) => {
    if (element.getAttribute(name) !== value) element.setAttribute(name, value);
  };
  const elementsFor = (id: number): AnnotationElements => {
    const existing = elementsById.get(id);
    if (existing) return existing;
    const leader = svgElement('g');
    const target = svgElement('g');
    const badge = svgElement('g');
    for (const element of [leader, target, badge]) {
      element.setAttribute('data-snapshot-selection-id', String(id));
    }
    leaderLayer.append(leader);
    targetLayer.append(target);
    badgeLayer.append(badge);
    const created = { leader, target, badge };
    elementsById.set(id, created);
    return created;
  };

  const reconcileLeader = (group: SVGGElement, points: string | null) => {
    if (!points) {
      if (group.firstChild) group.replaceChildren();
      return;
    }
    let leader = group.firstElementChild as SVGPolylineElement | null;
    if (!leader) {
      leader = svgElement('polyline');
      leader.setAttribute('class', 'snapshot-annotation__leader');
      leader.setAttribute('stroke-width', String(LEADER_LINE_WIDTH));
      group.append(leader);
    }
    setAttribute(leader, 'points', points);
  };

  const reconcileTarget = (group: SVGGElement, layout: ReturnType<typeof layoutAnnotations>[number]) => {
    const wantsMarker = layout.markerOnly;
    const hasMarker = group.firstElementChild?.classList.contains('snapshot-annotation__marker') ?? false;
    if (!group.firstElementChild || wantsMarker !== hasMarker) {
      if (wantsMarker) {
        const marker = svgElement('circle');
        marker.setAttribute('class', 'snapshot-annotation__marker');
        marker.setAttribute('r', String(MARKER_RADIUS - MARKER_RING_WIDTH / 2));
        marker.setAttribute('stroke-width', String(MARKER_RING_WIDTH));
        const inner = svgElement('circle');
        inner.setAttribute('class', 'snapshot-annotation__marker-inner');
        inner.setAttribute('r', String(MARKER_INNER_RADIUS));
        group.replaceChildren(marker, inner);
      } else {
        const frame = svgElement('rect');
        frame.setAttribute('class', 'snapshot-annotation__frame');
        frame.setAttribute('rx', String(Math.max(0, HIGHLIGHT_RADIUS - HIGHLIGHT_LINE_WIDTH / 2)));
        frame.setAttribute('stroke-width', String(HIGHLIGHT_LINE_WIDTH));
        group.replaceChildren(frame);
      }
    }

    if (wantsMarker) {
      for (const marker of Array.from(group.children) as SVGCircleElement[]) {
        setAttribute(marker, 'cx', String(layout.anchor.x));
        setAttribute(marker, 'cy', String(layout.anchor.y));
      }
      return;
    }

    const frame = group.firstElementChild!;
    setAttribute(frame, 'x', String(layout.frame.x + HIGHLIGHT_LINE_WIDTH / 2));
    setAttribute(frame, 'y', String(layout.frame.y + HIGHLIGHT_LINE_WIDTH / 2));
    setAttribute(frame, 'width', String(Math.max(0, layout.frame.width - HIGHLIGHT_LINE_WIDTH)));
    setAttribute(frame, 'height', String(Math.max(0, layout.frame.height - HIGHLIGHT_LINE_WIDTH)));
  };

  const reconcileBadge = (group: SVGGElement, point: { x: number; y: number } | null, labelValue: number) => {
    if (!point) {
      if (group.firstChild) group.replaceChildren();
      return;
    }
    let badge = group.children[0] as SVGCircleElement | undefined;
    let label = group.children[1] as SVGTextElement | undefined;
    if (!badge || !label) {
      badge = svgElement('circle');
      badge.setAttribute('class', 'snapshot-annotation__badge');
      badge.setAttribute('r', String(BADGE_RADIUS));
      label = svgElement('text');
      label.setAttribute('class', 'snapshot-annotation__badge-label');
      group.replaceChildren(badge, label);
    }
    setAttribute(badge, 'cx', String(point.x));
    setAttribute(badge, 'cy', String(point.y));
    setAttribute(label, 'x', String(point.x));
    setAttribute(label, 'y', String(point.y));
    setAttribute(label, 'font-size', String(getBadgeFontSize(labelValue)));
    if (label.textContent !== String(labelValue)) label.textContent = String(labelValue);
  };

  const renderCommitted = () => {
    committedLayer.setAttribute('viewBox', `0 0 ${window.innerWidth} ${window.innerHeight}`);
    committedLayer.setAttribute('preserveAspectRatio', 'none');
    const layouts = layoutAnnotations(
      committedSelections.map((selection) => ({
        bounds: selection.rect,
        order: selection.id,
      })),
      window.innerWidth,
      window.innerHeight,
    );
    const selectionById = new Map(committedSelections.map((selection) => [selection.id, selection]));

    for (const layout of layouts) {
      const selection = selectionById.get(layout.order)!;
      const elements = elementsFor(selection.id);
      reconcileLeader(
        elements.leader,
        layout.callout && layout.leader.length > 1
          ? layout.leader.map((point) => `${point.x},${point.y}`).join(' ')
          : null,
      );
      reconcileTarget(elements.target, layout);
      const labelValue = selection.label ?? selection.id;
      reconcileBadge(
        elements.badge,
        selection.label !== null || layout.callout ? layout.callout ?? layout.badgeAnchor : null,
        labelValue,
      );
    }
  };

  const isCommittedRect = (rect: SnapshotShieldRect) => committedRectKeys.has(rectKey(rect));

  return {
    preview(rect: SnapshotShieldRect | null) {
      preview.hidden = !rect || isCommittedRect(rect);
      document.body.classList.toggle('has-preview-target', Boolean(rect));
      if (rect && !preview.hidden) positionBox(preview, rect);
    },
    commit(selection: SnapshotShieldSelection & { id: number }) {
      if (committedIds.has(selection.id)) return;
      committedIds.add(selection.id);
      committedSelections.push(selection);
      committedRectKeys.add(rectKey(selection.rect));
      renderCommitted();
    },
    undo() {
      const selection = committedSelections.pop();
      if (!selection) return;
      committedIds.delete(selection.id);
      committedRectKeys.clear();
      for (const committed of committedSelections) committedRectKeys.add(rectKey(committed.rect));
      const elements = elementsById.get(selection.id);
      elements?.leader.remove();
      elements?.target.remove();
      elements?.badge.remove();
      elementsById.delete(selection.id);
      renderCommitted();
    },
    relayout() {
      renderCommitted();
    },
  };
}

window.addEventListener('message', (event) => {
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
  let moveFrame: number | null = null;
  let lastPoint: { clientX: number; clientY: number } | null = null;
  let requestSequence = 0;
  let latestRequestId = 0;
  let pointRevision = 0;
  let sentPointRevision = -1;
  let pendingHoverRequestId: number | null = null;
  let pendingHoverPointRevision: number | null = null;
  let pendingHoverTimeout: ReturnType<typeof setTimeout> | null = null;
  let candidateOffset = 0;
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

  const clearPendingHover = () => {
    if (pendingHoverTimeout !== null) clearTimeout(pendingHoverTimeout);
    pendingHoverTimeout = null;
    pendingHoverRequestId = null;
    pendingHoverPointRevision = null;
  };

  const clearCaptureTimeout = () => {
    if (captureTimeout !== null) clearTimeout(captureTimeout);
    captureTimeout = null;
  };

  const armCaptureTimeout = () => {
    clearCaptureTimeout();
    captureTimeout = setTimeout(() => {
      captureTimeout = null;
      capturing = false;
      lastCommitViaKeyboard = false;
      lastCommitWasRegion = false;
      pendingRegionCompletion?.();
      pendingRegionCompletion = null;
      sentPointRevision = -1;
      announce('擷取逾時，請重新選取目標');
      if (interactionsEnabled && !regionCapture?.isActive()) scheduleHover();
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
    clearPendingHover();
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

  const scheduleHover = () => {
    if (
      !interactionsEnabled ||
      capturing ||
      !lastPoint ||
      moveFrame !== null ||
      pendingHoverRequestId !== null ||
      sentPointRevision === pointRevision
    ) {
      return;
    }
    moveFrame = requestAnimationFrame(() => {
      moveFrame = null;
      if (
        !interactionsEnabled ||
        capturing ||
        !lastPoint ||
        pendingHoverRequestId !== null ||
        sentPointRevision === pointRevision
      ) {
        return;
      }
      latestRequestId = ++requestSequence;
      pendingHoverRequestId = latestRequestId;
      sentPointRevision = pointRevision;
      pendingHoverPointRevision = pointRevision;
      const hoverRequestId = latestRequestId;
      if (pendingHoverTimeout !== null) clearTimeout(pendingHoverTimeout);
      pendingHoverTimeout = setTimeout(() => {
        if (pendingHoverRequestId !== hoverRequestId) return;
        clearPendingHover();
        sentPointRevision = -1;
        scheduleHover();
      }, SHIELD_HOVER_TIMEOUT_MS);
      const message: SnapshotShieldPointerMoveMessage = {
        type: SNAPSHOT_SHIELD_POINTER_MOVE,
        token,
        requestId: latestRequestId,
        clientX: lastPoint.clientX,
        clientY: lastPoint.clientY,
        candidateOffset,
      };
      safePostToParent(message);
    });
  };

  const clearHover = () => {
    lastPoint = null;
    candidateOffset = 0;
    pointRevision++;
    latestRequestId = ++requestSequence;
    if (moveFrame !== null) cancelAnimationFrame(moveFrame);
    moveFrame = null;
    clearPendingHover();
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
    if (!lastPoint || lastPoint.clientX !== event.clientX || lastPoint.clientY !== event.clientY) {
      candidateOffset = 0;
    }
    lastPoint = { clientX: event.clientX, clientY: event.clientY };
    pointRevision++;
    scheduleHover();
  };

  const commitAt = (clientX: number, clientY: number, viaKeyboard: boolean) => {
    if (!interactionsEnabled || capturing) return;
    capturing = true;
    lastCommitViaKeyboard = viaKeyboard;
    lastPoint = { clientX, clientY };
    pointRevision++;
    latestRequestId = ++requestSequence;
    if (moveFrame !== null) cancelAnimationFrame(moveFrame);
    moveFrame = null;
    overlay.preview(null);
    lastPreviewRect = null;
    const message: SnapshotShieldPointerDownMessage = {
      type: SNAPSHOT_SHIELD_POINTER_DOWN,
      token,
      clientX,
      clientY,
      candidateOffset,
    };
    armCaptureTimeout();
    if (!safePostToParent(message)) clearCaptureTimeout();
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
    if (!lastPoint || lastPoint.clientX !== event.clientX || lastPoint.clientY !== event.clientY) {
      candidateOffset = 0;
    }
    commitAt(event.clientX, event.clientY, false);
  };

  const onCandidateKeyDown = (event: KeyboardEvent) => {
    if (regionCapture?.isActive()) return;
    if (event.target instanceof Element && event.target.closest('[data-frametrail-shield-toolbar]')) return;
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
    consume(event);
    if (!interactionsEnabled || capturing || !lastPoint) return;
    const delta = event.key === 'ArrowUp' ? 1 : -1;
    candidateOffset = Math.max(
      -SNAPSHOT_TARGET_OFFSET_LIMIT,
      Math.min(candidateOffset + delta, SNAPSHOT_TARGET_OFFSET_LIMIT),
    );
    pointRevision++;
    scheduleHover();
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
    const message: SnapshotShieldControlMessage = {
      type: SNAPSHOT_SHIELD_CONTROL,
      token,
      requestId,
      action,
      ...(undoToken ? { undoToken } : {}),
    };
    return new Promise<RecordingControlResult>((resolve) => {
      const timeout = setTimeout(
        () => settlePendingControl(requestId, SHIELD_CHANNEL_FAILURE),
        SHIELD_CONTROL_TIMEOUT_MS,
      );
      pendingControls.set(requestId, { resolve, timeout });
      if (!safePostToParent(message)) settlePendingControl(requestId, SHIELD_CHANNEL_FAILURE);
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
        lastCommitWasRegion = true;
        const message: SnapshotShieldRegionCaptureMessage = {
          type: SNAPSHOT_SHIELD_REGION_CAPTURE,
          token,
          rect,
        };
        await new Promise<void>((resolve) => {
          pendingRegionCompletion = resolve;
          armCaptureTimeout();
          if (!safePostToParent(message)) clearCaptureTimeout();
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
        if (interactionsEnabled && !capturing) scheduleHover();
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
    candidateOffset = 0;
    lastPoint = { clientX: anchor.x, clientY: anchor.y };
    pointRevision++;
    scheduleHover();
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
      if (event.data.requestId !== pendingHoverRequestId) return;
      const responsePointRevision = pendingHoverPointRevision;
      clearPendingHover();
      if (
        capturing ||
        event.data.requestId !== latestRequestId ||
        responsePointRevision !== pointRevision
      ) {
        scheduleHover();
        return;
      }
      candidateOffset = event.data.candidateOffset;
      lastPreviewRect = event.data.rect;
      overlay.preview(event.data.rect);
      scheduleHover();
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
      sentPointRevision = -1;
      if (interactionsEnabled && !regionCapture?.isActive()) scheduleHover();
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

  const readyMessage: SnapshotShieldReadyMessage = { type: SNAPSHOT_SHIELD_READY, token };
  safePostToParent(readyMessage);
});
