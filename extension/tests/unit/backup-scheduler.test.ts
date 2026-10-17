import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createBackupScheduler } from '@/lib/backup/use-folder-backup';

describe('createBackupScheduler', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('runs once after the edits settle', () => {
    const run = vi.fn();
    const { schedule } = createBackupScheduler(run, 3_000, 30_000);
    schedule();
    vi.advanceTimersByTime(2_000);
    schedule();
    vi.advanceTimersByTime(2_999);
    expect(run).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('still runs within the max wait while edits keep arriving', () => {
    const run = vi.fn();
    const { schedule } = createBackupScheduler(run, 3_000, 30_000);
    for (let elapsed = 0; elapsed < 30_000; elapsed += 200) {
      schedule();
      vi.advanceTimersByTime(200);
    }
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('starts a fresh wait window after a run, and cancel drops the pending run', () => {
    const run = vi.fn();
    const { schedule, cancel } = createBackupScheduler(run, 3_000, 30_000);
    schedule();
    vi.advanceTimersByTime(3_000);
    expect(run).toHaveBeenCalledTimes(1);
    schedule();
    cancel();
    vi.advanceTimersByTime(60_000);
    expect(run).toHaveBeenCalledTimes(1);
  });
});
