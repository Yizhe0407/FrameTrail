import { describe, expect, it, vi } from 'vitest';
import { orchestrateStepCapture, type StepCaptureHandlers } from '@/lib/step-capture';

/** Deferred promise plus a spy that records when it is invoked, so tests can
 *  assert both the ordering of effects and that the real capture wins the race. */
function createHarness(overrides: Partial<StepCaptureHandlers> = {}) {
  const log: string[] = [];
  let scroll = { x: 0, y: 0 };
  let previewVisible = false;

  let resolveCapture!: (saved: boolean) => void;
  const capturePromise = new Promise<boolean>((resolve) => {
    resolveCapture = resolve;
  });
  let cancel!: () => void;
  const cancelled = new Promise<void>((resolve) => {
    cancel = resolve;
  });

  const handlers: StepCaptureHandlers = {
    failsafeMs: 10_000,
    cancelled,
    readScroll: () => scroll,
    hidePreview: async () => {
      previewVisible = false;
      log.push('hide');
    },
    capture: () => {
      log.push('capture:start');
      // Simulate the auto-scroll that captureElement performs for an
      // out-of-viewport target before the screenshot is requested.
      scroll = { x: 0, y: 640 };
      return capturePromise.then((saved) => {
        log.push(`capture:done:${saved}`);
        return saved;
      });
    },
    endGesture: () => log.push('endGesture'),
    restoreScroll: (origin) => {
      scroll = origin;
      log.push(`restore:${origin.x},${origin.y}`);
    },
    replay: () => log.push('replay'),
    resumePreview: () => {
      previewVisible = true;
      log.push('resume');
    },
    ...overrides,
  };

  return {
    handlers,
    log,
    resolveCapture,
    cancel,
    getScroll: () => scroll,
    isPreviewVisible: () => previewVisible,
  };
}

describe('orchestrateStepCapture', () => {
  it('replays the click only after the real capture completes and keeps the preview hidden throughout', async () => {
    const harness = createHarness();
    const run = orchestrateStepCapture(harness.handlers);

    // Let the hide + capture-start microtasks flush before the screenshot lands.
    await Promise.resolve();
    await Promise.resolve();
    expect(harness.log).toEqual(['hide', 'capture:start']);
    // The preview must not re-appear while the capture is still in flight.
    expect(harness.isPreviewVisible()).toBe(false);

    // The real screenshot resolves late — replay must still wait for it.
    harness.resolveCapture(true);
    const outcome = await run;

    expect(outcome).toBe('captured');
    expect(harness.log).toEqual([
      'hide',
      'capture:start',
      'capture:done:true',
      'endGesture',
      'restore:0,0',
      'replay',
      'resume',
    ]);
    // Replay strictly follows the completed capture, and the preview only
    // returns afterwards.
    expect(harness.log.indexOf('replay')).toBeGreaterThan(harness.log.indexOf('capture:done:true'));
    expect(harness.log.indexOf('resume')).toBeGreaterThan(harness.log.indexOf('replay'));
  });

  it('restores the original scroll position after the capture and before the replay', async () => {
    const harness = createHarness();
    const run = orchestrateStepCapture(harness.handlers);
    await Promise.resolve();
    // The capture auto-scrolled the page down.
    expect(harness.getScroll()).toEqual({ x: 0, y: 640 });

    harness.resolveCapture(true);
    await run;

    // Scroll is back where the user left it, and the restore happened between
    // the screenshot and the replayed click.
    expect(harness.getScroll()).toEqual({ x: 0, y: 0 });
    expect(harness.log.indexOf('restore:0,0')).toBeGreaterThan(harness.log.indexOf('capture:done:true'));
    expect(harness.log.indexOf('restore:0,0')).toBeLessThan(harness.log.indexOf('replay'));
  });

  it('still replays but reports timeout when the capture out-runs its failsafe budget', async () => {
    vi.useFakeTimers();
    try {
      // capture() never resolves — a hung background must not strand the gesture.
      const harness = createHarness({ failsafeMs: 1_500 });
      const run = orchestrateStepCapture(harness.handlers);
      await vi.advanceTimersByTimeAsync(0); // flush hide + capture:start
      expect(harness.log).toEqual(['hide', 'capture:start']);

      await vi.advanceTimersByTimeAsync(1_500);
      const outcome = await run;

      expect(outcome).toBe('timeout');
      // The page is kept usable: gesture released, scroll restored, click replayed.
      expect(harness.log).toEqual(['hide', 'capture:start', 'endGesture', 'restore:0,0', 'replay', 'resume']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('times out preview preparation, invalidates background work, and releases the gesture', async () => {
    vi.useFakeTimers();
    try {
      const cancelCapture = vi.fn(async () => {});
      const harness = createHarness({
        failsafeMs: 1_500,
        hidePreview: () => new Promise<void>(() => {}),
        cancelCapture,
      });
      const run = orchestrateStepCapture(harness.handlers);

      await vi.advanceTimersByTimeAsync(1_500);
      const outcome = await run;

      expect(outcome).toBe('timeout');
      expect(cancelCapture).toHaveBeenCalledOnce();
      expect(harness.log).toEqual(['endGesture', 'restore:0,0', 'replay', 'resume']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not replay a cancelled gesture but still restores state', async () => {
    const harness = createHarness();
    const run = orchestrateStepCapture(harness.handlers);
    await Promise.resolve();

    harness.cancel();
    const outcome = await run;

    expect(outcome).toBe('cancelled');
    expect(harness.log).toContain('endGesture');
    expect(harness.log).toContain('restore:0,0');
    expect(harness.log).not.toContain('replay');
    expect(harness.log[harness.log.length - 1]).toBe('resume');
  });
});
