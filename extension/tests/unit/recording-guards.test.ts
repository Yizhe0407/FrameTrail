import { describe, expect, it } from 'vitest';
import type { RecordingState } from '@/lib/messages';
import {
  getCaptureGuardFailure,
  getRecordingTabUpdateAction,
  isMatchingSnapshotViewport,
} from '@/lib/recording-guards';

const state: RecordingState = {
  isRecording: true,
  sessionId: 'session-1',
  tabId: 7,
  error: null,
  mode: 'steps',
  numbered: true,
  groupAnchorId: null,
  runId: 'run-1',
  snapshotViewport: null,
  snapshotDevicePixelRatio: null,
};

const validGuard = {
  expectedControlVersion: 3,
  currentControlVersion: 3,
  runId: 'run-1',
  sessionId: 'session-1',
  tabId: 7,
  expectedUrl: 'https://example.com/page',
  state,
  activeTab: { id: 7, url: 'https://example.com/page' },
};

describe('getCaptureGuardFailure', () => {
  it('accepts only the current run on the expected active tab and URL', () => {
    expect(getCaptureGuardFailure(validGuard)).toBeNull();
    expect(getCaptureGuardFailure({ ...validGuard, currentControlVersion: 4 })).toBe('stale-run');
    expect(getCaptureGuardFailure({ ...validGuard, runId: 'old-run' })).toBe('stale-run');
    expect(getCaptureGuardFailure({ ...validGuard, sessionId: 'old-session' })).toBe('stale-run');
    expect(getCaptureGuardFailure({ ...validGuard, activeTab: { id: 8, url: validGuard.expectedUrl } })).toBe(
      'inactive-tab',
    );
    expect(getCaptureGuardFailure({ ...validGuard, activeTab: { id: 7, url: 'https://example.com/next' } })).toBe(
      'changed-url',
    );
  });
});

describe('isMatchingSnapshotViewport', () => {
  const viewport = { width: 1280, height: 720, scrollX: 20, scrollY: 40 };

  it('accepts subpixel scroll noise but rejects geometry, scroll, and DPR changes', () => {
    expect(isMatchingSnapshotViewport(viewport, 2, { ...viewport, scrollX: 20.5, scrollY: 39.5 }, 2)).toBe(true);
    expect(isMatchingSnapshotViewport(viewport, 2, { ...viewport, width: 1279 }, 2)).toBe(false);
    expect(isMatchingSnapshotViewport(viewport, 2, { ...viewport, scrollY: 42 }, 2)).toBe(false);
    expect(isMatchingSnapshotViewport(viewport, 2, viewport, 1)).toBe(false);
  });
});

describe('getRecordingTabUpdateAction', () => {
  it('never re-injects a snapshot recorder when the current document finishes loading', () => {
    expect(getRecordingTabUpdateAction('snapshot', { status: 'complete' })).toBe('ignore');
    expect(getRecordingTabUpdateAction('snapshot', { status: 'loading' })).toBe('stop-snapshot');
    expect(getRecordingTabUpdateAction('snapshot', { url: 'https://example.com/next' })).toBe('stop-snapshot');
  });

  it('re-injects steps mode only after navigation completes', () => {
    expect(getRecordingTabUpdateAction('steps', { status: 'loading' })).toBe('ignore');
    expect(getRecordingTabUpdateAction('steps', { status: 'complete' })).toBe('reinject');
  });
});
