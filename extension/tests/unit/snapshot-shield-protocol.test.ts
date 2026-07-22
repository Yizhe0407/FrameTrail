import { describe, expect, it } from 'vitest';
import {
  isSnapshotShieldFrameMessage,
  isSnapshotShieldInitMessage,
  isSnapshotShieldPortMessage,
  isSnapshotShieldRegionRect,
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
} from '@/lib/snapshot-shield-protocol';

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
        { type: SNAPSHOT_SHIELD_POINTER_DOWN, token, clientX: 120, clientY: 80, candidateOffset: 0 },
        token,
      ),
    ).toBe(true);
    expect(
      isSnapshotShieldPortMessage(
        { type: SNAPSHOT_SHIELD_POINTER_DOWN, token, clientX: Number.NaN, clientY: 80, candidateOffset: 0 },
        token,
      ),
    ).toBe(false);
    expect(
      isSnapshotShieldPortMessage(
        { type: SNAPSHOT_SHIELD_POINTER_DOWN, token, clientX: -1, clientY: 80, candidateOffset: 0 },
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
    expect(isSnapshotShieldPortMessage({ type: SNAPSHOT_SHIELD_REGION_CAPTURE, token, rect }, token)).toBe(true);
    expect(
      isSnapshotShieldPortMessage(
        { type: SNAPSHOT_SHIELD_REGION_CAPTURE, token: 'old-token', rect },
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
          { type: SNAPSHOT_SHIELD_REGION_CAPTURE, token, rect: invalidRect },
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
        { type: SNAPSHOT_SHIELD_PREVIEW, token, requestId: 3, rect, candidateOffset: 2 },
        token,
      ),
    ).toBe(true);
    expect(
      isSnapshotShieldFrameMessage({ type: SNAPSHOT_SHIELD_CAPTURE_COMPLETE, token, selection }, token),
    ).toBe(true);
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
});
