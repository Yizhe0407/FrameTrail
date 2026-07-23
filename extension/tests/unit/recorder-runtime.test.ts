import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRecorderRuntime } from '@/lib/recording/background/recorder-runtime';

describe('createRecorderRuntime', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('retries captureVisibleTab quota failures only after re-running the adjacent guard', async () => {
    vi.useFakeTimers();
    const captureVisibleTab = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error('MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND'))
      .mockResolvedValueOnce('data:image/jpeg;base64,ok');
    const guard = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    const runtime = createRecorderRuntime({
      captureVisibleTab,
      executeRecorderScript: vi.fn().mockResolvedValue(undefined),
      sendStopMessage: vi.fn().mockResolvedValue(undefined),
    });

    const pending = runtime.captureVisibleTabWithRetry(12, guard);
    await vi.advanceTimersByTimeAsync(500);

    await expect(pending).resolves.toBe('data:image/jpeg;base64,ok');
    expect(guard).toHaveBeenCalledTimes(2);
    expect(captureVisibleTab).toHaveBeenCalledTimes(2);
  });

  it('falls back from all-frame injection to the top document', async () => {
    const executeRecorderScript = vi
      .fn<(target: { tabId: number; allFrames?: boolean }) => Promise<void>>()
      .mockRejectedValueOnce(new Error('cross-origin frame'))
      .mockResolvedValueOnce(undefined);
    const runtime = createRecorderRuntime({
      captureVisibleTab: vi.fn(),
      executeRecorderScript,
      sendStopMessage: vi.fn().mockResolvedValue(undefined),
    });

    await expect(runtime.injectRecorder(34, true)).resolves.toBeUndefined();
    expect(executeRecorderScript).toHaveBeenNthCalledWith(1, { tabId: 34, allFrames: true });
    expect(executeRecorderScript).toHaveBeenNthCalledWith(2, { tabId: 34 });
  });

  it('treats a missing content listener during recorder shutdown as best-effort cleanup', async () => {
    const sendStopMessage = vi.fn().mockRejectedValue(new Error('No receiving end'));
    const runtime = createRecorderRuntime({
      captureVisibleTab: vi.fn(),
      executeRecorderScript: vi.fn().mockResolvedValue(undefined),
      sendStopMessage,
    });

    await expect(runtime.stopRecorderInTab(6)).resolves.toBeUndefined();
    expect(sendStopMessage).toHaveBeenCalledWith(6, { type: 'FRAME_TRAIL_STOP' });
  });
});
