// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ query: vi.fn() }));

vi.mock('wxt/browser', () => ({
  browser: {
    runtime: { getURL: (path: string) => `chrome-extension://frame${path}` },
    tabs: { query: mocks.query },
  },
}));

import RecordControls from '@/components/RecordControls';
import type { RecordingState, RecoverableRecordingError } from '@/lib/messages';

function recoveryState(recoverableError: RecoverableRecordingError): RecordingState {
  return {
    isRecording: false,
    phase: 'error',
    sessionId: 'session-1',
    tabId: null,
    error: recoverableError.message,
    recoverableError,
    mode: 'steps',
    itemCount: 0,
    numbered: true,
    groupAnchorId: null,
    runId: null,
    snapshotViewport: null,
    snapshotDevicePixelRatio: null,
  };
}

beforeEach(() => {
  mocks.query.mockReset();
  mocks.query.mockResolvedValue([{ id: 1, url: 'https://example.com' }]);
});

afterEach(cleanup);

describe('record controls recovery', () => {
  it('offers completion through the editor after the source tab closes', () => {
    const onOpenEditor = vi.fn();
    render(
      <RecordControls
        recording={recoveryState({ code: 'RECORDED_TAB_CLOSED', message: 'closed' })}
        onOpenEditor={onOpenEditor}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: '完成並開啟編輯器' }));
    expect(onOpenEditor).toHaveBeenCalledOnce();
    expect(screen.queryByRole('button', { name: '開始' })).toBeNull();
  });

  it('offers a retry and stable pending state after automatic navigation fails', () => {
    render(
      <RecordControls
        recording={recoveryState({ code: 'EDITOR_OPEN_FAILED', message: 'failed' })}
        onOpenEditor={vi.fn()}
        openingEditor
      />,
    );

    expect(screen.getByRole('button', { name: '正在開啟編輯器' }).hasAttribute('disabled')).toBe(true);
    expect(screen.queryByRole('button', { name: '開始' })).toBeNull();
  });
});
