export const SNAPSHOT_SHIELD_INIT = 'FRAME_TRAIL_SNAPSHOT_SHIELD_INIT';
export const SNAPSHOT_SHIELD_READY = 'FRAME_TRAIL_SNAPSHOT_SHIELD_READY';
export const SNAPSHOT_SHIELD_POINTER_DOWN = 'FRAME_TRAIL_SNAPSHOT_SHIELD_POINTER_DOWN';
export const SNAPSHOT_SHIELD_POINTER_MOVE = 'FRAME_TRAIL_SNAPSHOT_SHIELD_POINTER_MOVE';
export const SNAPSHOT_SHIELD_PREVIEW = 'FRAME_TRAIL_SNAPSHOT_SHIELD_PREVIEW';
export const SNAPSHOT_SHIELD_CAPTURE_COMPLETE = 'FRAME_TRAIL_SNAPSHOT_SHIELD_CAPTURE_COMPLETE';
export const SNAPSHOT_SHIELD_COMMIT = 'FRAME_TRAIL_SNAPSHOT_SHIELD_COMMIT';
export const SNAPSHOT_TARGET_OFFSET_LIMIT = 4_096;

export interface SnapshotShieldRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface SnapshotShieldSelection {
  rect: SnapshotShieldRect;
  label: number | null;
}

export interface SnapshotShieldPreviewResult {
  rect: SnapshotShieldRect | null;
  candidateOffset: number;
}

export interface SnapshotShieldInitMessage {
  type: typeof SNAPSHOT_SHIELD_INIT;
  token: string;
}

export interface SnapshotShieldReadyMessage {
  type: typeof SNAPSHOT_SHIELD_READY;
  token: string;
}

export interface SnapshotShieldPointerDownMessage {
  type: typeof SNAPSHOT_SHIELD_POINTER_DOWN;
  token: string;
  clientX: number;
  clientY: number;
  candidateOffset: number;
}

export interface SnapshotShieldPointerMoveMessage {
  type: typeof SNAPSHOT_SHIELD_POINTER_MOVE;
  token: string;
  requestId: number;
  clientX: number;
  clientY: number;
  candidateOffset: number;
}

export interface SnapshotShieldPreviewMessage {
  type: typeof SNAPSHOT_SHIELD_PREVIEW;
  token: string;
  requestId: number;
  rect: SnapshotShieldRect | null;
  candidateOffset: number;
}

export interface SnapshotShieldCaptureCompleteMessage {
  type: typeof SNAPSHOT_SHIELD_CAPTURE_COMPLETE;
  token: string;
  selection: (SnapshotShieldSelection & { id: number }) | null;
}

export interface SnapshotShieldCommitMessage {
  type: typeof SNAPSHOT_SHIELD_COMMIT;
  token: string;
  selection: SnapshotShieldSelection & { id: number };
}

export type SnapshotShieldPortMessage =
  | SnapshotShieldReadyMessage
  | SnapshotShieldPointerDownMessage
  | SnapshotShieldPointerMoveMessage;

export type SnapshotShieldFrameMessage =
  | SnapshotShieldPreviewMessage
  | SnapshotShieldCaptureCompleteMessage
  | SnapshotShieldCommitMessage;

function isRequestId(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isCandidateOffset(value: unknown): value is number {
  return Number.isSafeInteger(value) && Math.abs(value as number) <= SNAPSHOT_TARGET_OFFSET_LIMIT;
}

function isRect(value: unknown): value is SnapshotShieldRect {
  if (!value || typeof value !== 'object') return false;
  const rect = value as Partial<SnapshotShieldRect>;
  return (
    Number.isFinite(rect.x) &&
    Number.isFinite(rect.y) &&
    Number.isFinite(rect.width) &&
    Number.isFinite(rect.height) &&
    rect.width! >= 0 &&
    rect.height! >= 0
  );
}

function isSelection(value: unknown): value is SnapshotShieldSelection & { id: number } {
  if (!value || typeof value !== 'object') return false;
  const selection = value as Partial<SnapshotShieldSelection & { id: number }>;
  return (
    isRequestId(selection.id) &&
    isRect(selection.rect) &&
    (selection.label === null || (Number.isSafeInteger(selection.label) && selection.label! > 0))
  );
}

export function isSnapshotShieldInitMessage(value: unknown, token: string): value is SnapshotShieldInitMessage {
  if (!value || typeof value !== 'object') return false;
  const message = value as Partial<SnapshotShieldInitMessage>;
  return message.type === SNAPSHOT_SHIELD_INIT && message.token === token;
}

export function isSnapshotShieldPortMessage(value: unknown, token: string): value is SnapshotShieldPortMessage {
  if (!value || typeof value !== 'object') return false;
  const message = value as {
    type?: SnapshotShieldPortMessage['type'];
    token?: string;
    requestId?: number;
    clientX?: number;
    clientY?: number;
    candidateOffset?: number;
  };
  if (message.token !== token) return false;
  if (message.type === SNAPSHOT_SHIELD_READY) return true;
  const hasPoint =
    Number.isFinite(message.clientX) &&
    Number.isFinite(message.clientY) &&
    message.clientX! >= 0 &&
    message.clientY! >= 0;
  if (message.type === SNAPSHOT_SHIELD_POINTER_DOWN) {
    return hasPoint && isCandidateOffset(message.candidateOffset);
  }
  return (
    message.type === SNAPSHOT_SHIELD_POINTER_MOVE &&
    hasPoint &&
    isRequestId(message.requestId) &&
    isCandidateOffset(message.candidateOffset)
  );
}

export function isSnapshotShieldFrameMessage(value: unknown, token: string): value is SnapshotShieldFrameMessage {
  if (!value || typeof value !== 'object') return false;
  const message = value as {
    type?: SnapshotShieldFrameMessage['type'];
    token?: string;
    requestId?: number;
    rect?: SnapshotShieldRect | null;
    candidateOffset?: number;
    selection?: (SnapshotShieldSelection & { id: number }) | null;
  };
  if (message.token !== token) return false;
  if (message.type === SNAPSHOT_SHIELD_PREVIEW) {
    return (
      isRequestId(message.requestId) &&
      isCandidateOffset(message.candidateOffset) &&
      (message.rect === null || isRect(message.rect))
    );
  }
  if (message.type === SNAPSHOT_SHIELD_CAPTURE_COMPLETE) {
    return message.selection === null || isSelection(message.selection);
  }
  return message.type === SNAPSHOT_SHIELD_COMMIT && isSelection(message.selection);
}
