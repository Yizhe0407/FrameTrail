import { describe, expect, it } from 'vitest';
import {
  isSnapshotShieldFrameMessage,
  isSnapshotShieldInitMessage,
  isSnapshotShieldPortMessage,
  SNAPSHOT_SHIELD_CAPTURE_COMPLETE,
  SNAPSHOT_SHIELD_COMMIT,
  SNAPSHOT_SHIELD_CONTROL,
  SNAPSHOT_SHIELD_INIT,
  SNAPSHOT_SHIELD_POINTER_DOWN,
  SNAPSHOT_SHIELD_POINTER_MOVE,
  SNAPSHOT_SHIELD_PREVIEW,
  SNAPSHOT_SHIELD_READY,
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
    for (const action of ['PREPARE_NEXT_SNAPSHOT', 'CREATE_NEXT_SNAPSHOT']) {
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
});
