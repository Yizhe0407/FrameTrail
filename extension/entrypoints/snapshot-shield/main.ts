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
  HIGHLIGHT_RADIUS,
  LEADER_LINE_WIDTH,
  MARKER_INNER_RADIUS,
  MARKER_RADIUS,
  MARKER_RING_WIDTH,
  fitHighlightFrame,
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
    ensureKeyboardFocus();
    if (!lastPoint || lastPoint.clientX !== event.clientX || lastPoint.clientY !== event.clientY) {
      candidateOffset = 0;
    }
    lastPoint = { clientX: event.clientX, clientY: event.clientY };
    pointRevision++;
    scheduleHover();
  };

  const onPointerDown = (event: PointerEvent) => {
    consume(event);
    ensureKeyboardFocus();
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
