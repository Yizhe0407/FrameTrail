import {
  isSnapshotShieldFrameMessage,
  isSnapshotShieldInitMessage,
  SNAPSHOT_SHIELD_CAPTURE_COMPLETE,
  SNAPSHOT_SHIELD_COMMIT,
  SNAPSHOT_SHIELD_POINTER_DOWN,
  SNAPSHOT_SHIELD_POINTER_MOVE,
  SNAPSHOT_SHIELD_PREVIEW,
  SNAPSHOT_SHIELD_READY,
  SNAPSHOT_TARGET_OFFSET_LIMIT,
  type SnapshotShieldPointerDownMessage,
  type SnapshotShieldPointerMoveMessage,
  type SnapshotShieldReadyMessage,
  type SnapshotShieldRect,
  type SnapshotShieldSelection,
} from '@/lib/snapshot-shield-protocol';
import {
  BADGE_RADIUS,
  HIGHLIGHT_LINE_WIDTH,
  HIGHLIGHT_PADDING,
  HIGHLIGHT_RADIUS,
  LEADER_LINE_WIDTH,
  MARKER_INNER_RADIUS,
  MARKER_RADIUS,
  MARKER_RING_WIDTH,
  getBadgeFontSize,
  layoutAnnotations,
} from '@/lib/annotate';

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
  if (event.cancelable) event.preventDefault();
  event.stopImmediatePropagation();
}

function positionBox(element: HTMLElement, rect: SnapshotShieldRect): void {
  const left = Math.max(0, rect.x - HIGHLIGHT_PADDING);
  const top = Math.max(0, rect.y - HIGHLIGHT_PADDING);
  const right = Math.min(window.innerWidth, rect.x + rect.width + HIGHLIGHT_PADDING);
  const bottom = Math.min(window.innerHeight, rect.y + rect.height + HIGHLIGHT_PADDING);
  element.style.left = `${left}px`;
  element.style.top = `${top}px`;
  element.style.width = `${Math.max(0, right - left)}px`;
  element.style.height = `${Math.max(0, bottom - top)}px`;
}

function createOverlay() {
  const root = document.createElement('div');
  root.className = 'snapshot-overlay';
  root.setAttribute('aria-hidden', 'true');

  const committedLayer = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  committedLayer.setAttribute('class', 'snapshot-overlay__committed');
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

  const renderCommitted = () => {
    committedLayer.setAttribute('viewBox', `0 0 ${window.innerWidth} ${window.innerHeight}`);
    committedLayer.setAttribute('preserveAspectRatio', 'none');
    const layouts = layoutAnnotations(
      committedSelections.map((selection) => ({
        bounds: selection.rect,
        order: selection.label ?? selection.id,
      })),
      window.innerWidth,
      window.innerHeight,
    );
    const selectionByOrder = new Map(
      committedSelections.map((selection) => [selection.label ?? selection.id, selection]),
    );
    const leaders = document.createDocumentFragment();
    const targets = document.createDocumentFragment();
    const badges = document.createDocumentFragment();

    for (const layout of layouts) {
      if (layout.callout && layout.leader.length > 1) {
        const leader = svgElement('polyline');
        leader.setAttribute('class', 'snapshot-annotation__leader');
        leader.setAttribute('points', layout.leader.map((point) => `${point.x},${point.y}`).join(' '));
        leader.setAttribute('stroke-width', String(LEADER_LINE_WIDTH));
        leaders.append(leader);
      }

      if (layout.markerOnly) {
        const marker = svgElement('circle');
        marker.setAttribute('class', 'snapshot-annotation__marker');
        marker.setAttribute('cx', String(layout.anchor.x));
        marker.setAttribute('cy', String(layout.anchor.y));
        marker.setAttribute('r', String(MARKER_RADIUS - MARKER_RING_WIDTH / 2));
        marker.setAttribute('stroke-width', String(MARKER_RING_WIDTH));
        targets.append(marker);

        const markerInner = svgElement('circle');
        markerInner.setAttribute('class', 'snapshot-annotation__marker-inner');
        markerInner.setAttribute('cx', String(layout.anchor.x));
        markerInner.setAttribute('cy', String(layout.anchor.y));
        markerInner.setAttribute('r', String(MARKER_INNER_RADIUS));
        targets.append(markerInner);
      } else {
        const frame = svgElement('rect');
        frame.setAttribute('class', 'snapshot-annotation__frame');
        frame.setAttribute('x', String(layout.frame.x + HIGHLIGHT_LINE_WIDTH / 2));
        frame.setAttribute('y', String(layout.frame.y + HIGHLIGHT_LINE_WIDTH / 2));
        frame.setAttribute('width', String(Math.max(0, layout.frame.width - HIGHLIGHT_LINE_WIDTH)));
        frame.setAttribute('height', String(Math.max(0, layout.frame.height - HIGHLIGHT_LINE_WIDTH)));
        frame.setAttribute('rx', String(Math.max(0, HIGHLIGHT_RADIUS - HIGHLIGHT_LINE_WIDTH / 2)));
        frame.setAttribute('stroke-width', String(HIGHLIGHT_LINE_WIDTH));
        targets.append(frame);
      }

      const selection = selectionByOrder.get(layout.order);
      if (selection?.label !== null || layout.callout) {
        const badgePoint = layout.callout ?? layout.badgeAnchor;
        const badge = svgElement('circle');
        badge.setAttribute('class', 'snapshot-annotation__badge');
        badge.setAttribute('cx', String(badgePoint.x));
        badge.setAttribute('cy', String(badgePoint.y));
        badge.setAttribute('r', String(BADGE_RADIUS));
        badges.append(badge);

        const label = svgElement('text');
        label.setAttribute('class', 'snapshot-annotation__badge-label');
        label.setAttribute('x', String(badgePoint.x));
        label.setAttribute('y', String(badgePoint.y));
        label.setAttribute('font-size', String(getBadgeFontSize(layout.order)));
        label.textContent = String(layout.order);
        badges.append(label);
      }
    }

    committedLayer.replaceChildren(leaders, targets, badges);
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
  let capturing = false;
  let moveFrame: number | null = null;
  let lastPoint: { clientX: number; clientY: number } | null = null;
  let requestSequence = 0;
  let latestRequestId = 0;
  let pointRevision = 0;
  let sentPointRevision = -1;
  let pendingHoverRequestId: number | null = null;
  let pendingHoverPointRevision: number | null = null;
  let candidateOffset = 0;

  const scheduleHover = () => {
    if (
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
      if (capturing || !lastPoint || pendingHoverRequestId !== null || sentPointRevision === pointRevision) return;
      latestRequestId = ++requestSequence;
      pendingHoverRequestId = latestRequestId;
      sentPointRevision = pointRevision;
      pendingHoverPointRevision = pointRevision;
      const message: SnapshotShieldPointerMoveMessage = {
        type: SNAPSHOT_SHIELD_POINTER_MOVE,
        token,
        requestId: latestRequestId,
        clientX: lastPoint.clientX,
        clientY: lastPoint.clientY,
        candidateOffset,
      };
      port.postMessage(message);
    });
  };

  const clearHover = () => {
    lastPoint = null;
    candidateOffset = 0;
    pointRevision++;
    latestRequestId = ++requestSequence;
    if (moveFrame !== null) cancelAnimationFrame(moveFrame);
    moveFrame = null;
    overlay.preview(null);
  };

  const onPointerMove = (event: PointerEvent) => {
    if (!lastPoint || lastPoint.clientX !== event.clientX || lastPoint.clientY !== event.clientY) {
      candidateOffset = 0;
    }
    lastPoint = { clientX: event.clientX, clientY: event.clientY };
    pointRevision++;
    scheduleHover();
  };

  const onPointerDown = (event: PointerEvent) => {
    consume(event);
    if (capturing || event.button !== 0 || !event.isPrimary) return;
    if (!lastPoint || lastPoint.clientX !== event.clientX || lastPoint.clientY !== event.clientY) {
      candidateOffset = 0;
    }
    capturing = true;
    lastPoint = { clientX: event.clientX, clientY: event.clientY };
    pointRevision++;
    latestRequestId = ++requestSequence;
    if (moveFrame !== null) cancelAnimationFrame(moveFrame);
    moveFrame = null;
    overlay.preview(null);
    const message: SnapshotShieldPointerDownMessage = {
      type: SNAPSHOT_SHIELD_POINTER_DOWN,
      token,
      clientX: event.clientX,
      clientY: event.clientY,
      candidateOffset,
    };
    port.postMessage(message);
  };

  const onCandidateKeyDown = (event: KeyboardEvent) => {
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
    consume(event);
    if (capturing || !lastPoint) return;
    const delta = event.key === 'ArrowUp' ? 1 : -1;
    candidateOffset = Math.max(
      -SNAPSHOT_TARGET_OFFSET_LIMIT,
      Math.min(candidateOffset + delta, SNAPSHOT_TARGET_OFFSET_LIMIT),
    );
    pointRevision++;
    scheduleHover();
  };

  port.onmessage = (event) => {
    if (!isSnapshotShieldFrameMessage(event.data, token)) return;
    if (event.data.type === SNAPSHOT_SHIELD_PREVIEW) {
      if (event.data.requestId !== pendingHoverRequestId) return;
      const responsePointRevision = pendingHoverPointRevision;
      pendingHoverRequestId = null;
      pendingHoverPointRevision = null;
      if (
        capturing ||
        event.data.requestId !== latestRequestId ||
        responsePointRevision !== pointRevision
      ) {
        scheduleHover();
        return;
      }
      candidateOffset = event.data.candidateOffset;
      overlay.preview(event.data.rect);
      scheduleHover();
      return;
    }
    if (event.data.type === SNAPSHOT_SHIELD_COMMIT) {
      overlay.commit(event.data.selection);
      return;
    }
    if (event.data.type === SNAPSHOT_SHIELD_CAPTURE_COMPLETE) {
      if (event.data.selection) overlay.commit(event.data.selection);
      capturing = false;
      sentPointRevision = -1;
      scheduleHover();
    }
  };

  window.addEventListener('pointermove', onPointerMove, { capture: true, passive: true });
  window.addEventListener('pointerout', (event) => {
    if (!event.relatedTarget) clearHover();
  }, { capture: true });
  window.addEventListener('pointerdown', onPointerDown, { capture: true, passive: false });
  window.addEventListener('keydown', onCandidateKeyDown, { capture: true, passive: false });
  for (const type of FREEZE_EVENTS) {
    window.addEventListener(type, consume, { capture: true, passive: false });
  }
  window.addEventListener('resize', () => {
    // A resize invalidates both hit targets and the collision layout.
    clearHover();
    overlay.relayout();
  });
  port.start();

  const readyMessage: SnapshotShieldReadyMessage = { type: SNAPSHOT_SHIELD_READY, token };
  port.postMessage(readyMessage);
});
