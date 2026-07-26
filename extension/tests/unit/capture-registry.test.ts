import { describe, expect, it } from 'vitest';
import { StaleCaptureError } from '@/lib/recording/background-queues';
import * as registry from '@/lib/recording/background/capture-registry';

// The registry is deliberate module state (one per service worker); each test
// uses its own capture ids so no reset between tests is needed.
describe('capture registry', () => {
  it('rejects a cancelled capture and clears the record on release', () => {
    registry.cancelCapture('cancel-1');
    expect(() => registry.assertCaptureNotCancelled('cancel-1')).toThrow(StaleCaptureError);
    expect(() => registry.assertCaptureNotCancelled('cancel-2')).not.toThrow();

    registry.releaseCapture('cancel-1');
    expect(() => registry.assertCaptureNotCancelled('cancel-1')).not.toThrow();
  });

  it('lets a committing capture win over a late cancellation', () => {
    registry.markCaptureCommitting('commit-1');
    expect(registry.isCaptureCommitting('commit-1')).toBe(true);

    registry.cancelCapture('commit-1');
    expect(() => registry.assertCaptureNotCancelled('commit-1')).not.toThrow();

    registry.releaseCapture('commit-1');
    expect(registry.isCaptureCommitting('commit-1')).toBe(false);
  });

  it('bounds the cancellation memory by evicting the oldest ids', () => {
    for (let i = 0; i < 1_025; i += 1) registry.cancelCapture(`evict-${i}`);
    // The oldest record was evicted; the newest still rejects.
    expect(() => registry.assertCaptureNotCancelled('evict-0')).not.toThrow();
    expect(() => registry.assertCaptureNotCancelled('evict-1024')).toThrow(StaleCaptureError);
  });
});
