import { describe, expect, it } from 'vitest';
import {
  buildShieldTokenStorageKey,
  isSnapshotShieldTokenRecord,
  isSnapshotShieldFrameMessage,
  isSnapshotShieldInitMessage,
  isSnapshotShieldPortMessage,
  isSnapshotShieldRegionRect,
  SNAPSHOT_SHIELD_TOKEN_STORAGE_PREFIX,
  SNAPSHOT_SHIELD_CANDIDATES,
  SNAPSHOT_SHIELD_CAPTURE_COMPLETE,
  SNAPSHOT_SHIELD_COMMIT,
  SNAPSHOT_SHIELD_CONTROL,
  SNAPSHOT_SHIELD_INIT,
  SNAPSHOT_SHIELD_POINTER_DOWN,
  SNAPSHOT_SHIELD_POINTER_MOVE,
  SNAPSHOT_SHIELD_PREVIEW,
  SNAPSHOT_SHIELD_READY,
  SNAPSHOT_SHIELD_REGION_CAPTURE,
} from '@/lib/recording/snapshot-shield-protocol';

describe('snapshot shield protocol', () => {
  const token = 'run-token';

  it('accepts only initialization for the current shield token', () => {
    expect(isSnapshotShieldInitMessage({ type: SNAPSHOT_SHIELD_INIT, token }, token)).toBe(true);
    expect(isSnapshotShieldInitMessage({ type: SNAPSHOT_SHIELD_INIT, token: 'old-token' }, token)).toBe(false);
    expect(isSnapshotShieldInitMessage(null, token)).toBe(false);
  });

  it('validates ready and finite pointer coordinates', () => {
    expect(isSnapshotShieldPortMessage({ type: SNAPSHOT_SHIELD_READY, token }, token)).toBe(true);
    expect(
      isSnapshotShieldPortMessage(
        { type: SNAPSHOT_SHIELD_POINTER_DOWN, token, captureId: 1, clientX: 120, clientY: 80, candidateOffset: 0 },
        token,
      ),
    ).toBe(true);
    // A pointer-down without its capture generation can never be matched to a
    // completion, so it is rejected outright.
    expect(
      isSnapshotShieldPortMessage(
        { type: SNAPSHOT_SHIELD_POINTER_DOWN, token, clientX: 120, clientY: 80, candidateOffset: 0 },
        token,
      ),
    ).toBe(false);
    expect(
      isSnapshotShieldPortMessage(
        { type: SNAPSHOT_SHIELD_POINTER_DOWN, token, captureId: -1, clientX: 120, clientY: 80, candidateOffset: 0 },
        token,
      ),
    ).toBe(false);
    expect(
      isSnapshotShieldPortMessage(
        { type: SNAPSHOT_SHIELD_POINTER_DOWN, token, captureId: 1, clientX: Number.NaN, clientY: 80, candidateOffset: 0 },
        token,
      ),
    ).toBe(false);
    expect(
      isSnapshotShieldPortMessage(
        { type: SNAPSHOT_SHIELD_POINTER_DOWN, token, captureId: 1, clientX: -1, clientY: 80, candidateOffset: 0 },
        token,
      ),
    ).toBe(false);
    expect(
      isSnapshotShieldPortMessage(
        {
          type: SNAPSHOT_SHIELD_POINTER_MOVE,
          token,
          requestId: 4,
          clientX: 120,
          clientY: 80,
          candidateOffset: 1,
        },
        token,
      ),
    ).toBe(true);
    expect(
      isSnapshotShieldPortMessage(
        {
          type: SNAPSHOT_SHIELD_POINTER_MOVE,
          token,
          requestId: -1,
          clientX: 120,
          clientY: 80,
          candidateOffset: 0,
        },
        token,
      ),
    ).toBe(false);
    expect(
      isSnapshotShieldPortMessage(
        {
          type: SNAPSHOT_SHIELD_POINTER_MOVE,
          token,
          requestId: 4,
          clientX: 120,
          clientY: 80,
          candidateOffset: 4_097,
        },
        token,
      ),
    ).toBe(false);
    expect(isSnapshotShieldPortMessage({ type: SNAPSHOT_SHIELD_READY, token: 'old-token' }, token)).toBe(false);
  });

  it('authenticates and validates region capture rectangles', () => {
    const rect = { x: 10, y: 20, width: 30, height: 40 };
    expect(isSnapshotShieldRegionRect(rect)).toBe(true);
    expect(
      isSnapshotShieldPortMessage({ type: SNAPSHOT_SHIELD_REGION_CAPTURE, token, captureId: 2, rect }, token),
    ).toBe(true);
    expect(
      isSnapshotShieldPortMessage({ type: SNAPSHOT_SHIELD_REGION_CAPTURE, token, rect }, token),
    ).toBe(false);
    expect(
      isSnapshotShieldPortMessage(
        { type: SNAPSHOT_SHIELD_REGION_CAPTURE, token: 'old-token', captureId: 2, rect },
        token,
      ),
    ).toBe(false);

    for (const invalidRect of [
      { ...rect, x: -1 },
      { ...rect, width: 7 },
      { ...rect, height: Number.NaN },
      { ...rect, x: Number.POSITIVE_INFINITY },
      { x: 999_990, y: 20, width: 30, height: 40 },
    ]) {
      expect(isSnapshotShieldRegionRect(invalidRect)).toBe(false);
      expect(
        isSnapshotShieldPortMessage(
          { type: SNAPSHOT_SHIELD_REGION_CAPTURE, token, captureId: 2, rect: invalidRect },
          token,
        ),
      ).toBe(false);
    }
  });

  it('validates preview and committed selection messages sent back to the frame', () => {
    const rect = { x: 20, y: 30, width: 100, height: 40 };
    const selection = { id: 1, rect, label: 2 };
    expect(
      isSnapshotShieldFrameMessage(
        { type: SNAPSHOT_SHIELD_PREVIEW, token, requestId: 3, rect, candidateOffset: 2, offsetRange: { min: -1, max: 3 } },
        token,
      ),
    ).toBe(true);
    // The offset range drives the shield's cycling hint, so a preview without
    // one (or with an inverted one) is not a usable message.
    expect(
      isSnapshotShieldFrameMessage(
        { type: SNAPSHOT_SHIELD_PREVIEW, token, requestId: 3, rect, candidateOffset: 2 },
        token,
      ),
    ).toBe(false);
    expect(
      isSnapshotShieldFrameMessage(
        { type: SNAPSHOT_SHIELD_PREVIEW, token, requestId: 3, rect, candidateOffset: 0, offsetRange: { min: 2, max: 1 } },
        token,
      ),
    ).toBe(false);
    expect(
      isSnapshotShieldFrameMessage({ type: SNAPSHOT_SHIELD_CAPTURE_COMPLETE, token, captureId: 5, selection }, token),
    ).toBe(true);
    expect(
      isSnapshotShieldFrameMessage(
        { type: SNAPSHOT_SHIELD_CAPTURE_COMPLETE, token, captureId: 5, selection: null },
        token,
      ),
    ).toBe(true);
    // Completions must echo the capture generation they settle.
    expect(
      isSnapshotShieldFrameMessage({ type: SNAPSHOT_SHIELD_CAPTURE_COMPLETE, token, selection }, token),
    ).toBe(false);
    expect(isSnapshotShieldFrameMessage({ type: SNAPSHOT_SHIELD_COMMIT, token, selection }, token)).toBe(true);
    expect(
      isSnapshotShieldFrameMessage(
        { type: SNAPSHOT_SHIELD_COMMIT, token, selection: { ...selection, label: 0 } },
        token,
      ),
    ).toBe(false);
    expect(
      isSnapshotShieldFrameMessage(
        {
          type: SNAPSHOT_SHIELD_PREVIEW,
          token,
          requestId: 3,
          rect: { ...rect, width: -1 },
          candidateOffset: 0,
          offsetRange: { min: 0, max: 0 },
        },
        token,
      ),
    ).toBe(false);
  });

  it('accepts the multi-snapshot controls and rejects unknown actions', () => {
    for (const action of [
      'PREPARE_NEXT_SNAPSHOT',
      'CREATE_NEXT_SNAPSHOT',
      'REBUILD_INVALIDATED_SNAPSHOT',
      'DISCARD_CURRENT_RECORDING',
    ]) {
      expect(
        isSnapshotShieldPortMessage(
          { type: SNAPSHOT_SHIELD_CONTROL, token, requestId: 8, action },
          token,
        ),
      ).toBe(true);
    }
    expect(
      isSnapshotShieldPortMessage(
        { type: SNAPSHOT_SHIELD_CONTROL, token, requestId: 8, action: 'REPLACE_SNAPSHOT' },
        token,
      ),
    ).toBe(false);
  });

  it('validates keyboard candidate messages', () => {
    expect(
      isSnapshotShieldFrameMessage(
        { type: SNAPSHOT_SHIELD_CANDIDATES, token, anchors: [{ x: 10, y: 20, label: 'Submit' }] },
        token,
      ),
    ).toBe(true);
    expect(
      isSnapshotShieldFrameMessage({ type: SNAPSHOT_SHIELD_CANDIDATES, token, anchors: [] }, token),
    ).toBe(true);
    // Non-finite coordinate and non-string label are rejected.
    expect(
      isSnapshotShieldFrameMessage(
        { type: SNAPSHOT_SHIELD_CANDIDATES, token, anchors: [{ x: Number.NaN, y: 0, label: 'x' }] },
        token,
      ),
    ).toBe(false);
    expect(
      isSnapshotShieldFrameMessage(
        { type: SNAPSHOT_SHIELD_CANDIDATES, token, anchors: [{ x: 0, y: 0, label: 42 }] },
        token,
      ),
    ).toBe(false);
    expect(
      isSnapshotShieldFrameMessage({ type: SNAPSHOT_SHIELD_CANDIDATES, token: 'old', anchors: [] }, token),
    ).toBe(false);
  });

  it('builds namespaced storage keys for shield init tokens', () => {
    expect(buildShieldTokenStorageKey('frame-1')).toBe(`${SNAPSHOT_SHIELD_TOKEN_STORAGE_PREFIX}frame-1`);
  });

  it('validates shield init token records fetched from extension storage', () => {
    expect(isSnapshotShieldTokenRecord({ token: 'secret', createdAt: 123 })).toBe(true);
    expect(isSnapshotShieldTokenRecord(null)).toBe(false);
    expect(isSnapshotShieldTokenRecord({ token: '', createdAt: 123 })).toBe(false);
    expect(isSnapshotShieldTokenRecord({ token: 'x'.repeat(257), createdAt: 123 })).toBe(false);
    expect(isSnapshotShieldTokenRecord({ token: 'secret', createdAt: Number.NaN })).toBe(false);
    expect(isSnapshotShieldTokenRecord({ token: 42, createdAt: 123 })).toBe(false);
  });
});
