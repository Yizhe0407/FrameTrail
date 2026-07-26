import { describe, expect, it, vi } from 'vitest';
import {
  createLateClickSuppressor,
  createStepCaptureDedup,
  orchestrateStepCapture,
  type StepCaptureHandlers,
} from '@/lib/capture/step-capture';

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

  it('keeps a committed capture intact when the response channel dies: failed outcome never invalidates background work', async () => {
    // A link-click capture commits in the background before the response is
    // sent; if that response is lost (page already navigating into bfcache),
    // the content side sees a failure. It must NOT send a cancellation — the
    // committed step has to survive — and it must still replay so the page
    // stays usable.
    const cancelCapture = vi.fn(async () => {});
    const harness = createHarness({
      capture: () => Promise.reject(new Error('message channel closed')),
      cancelCapture,
    });
    const outcome = await orchestrateStepCapture(harness.handlers);

    expect(outcome).toBe('failed');
    expect(cancelCapture).not.toHaveBeenCalled();
    expect(harness.log).toContain('endGesture');
    expect(harness.log).toContain('replay');
    expect(harness.log[harness.log.length - 1]).toBe('resume');
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

describe('createStepCaptureDedup', () => {
  it('declines a repeated key inside the window and accepts it after', () => {
    let clock = 1_000;
    const dedup = createStepCaptureDedup<string>(400, () => clock);
    expect(dedup.shouldCapture('a')).toBe(true);
    clock += 100;
    expect(dedup.shouldCapture('a')).toBe(false);
    clock += 400;
    expect(dedup.shouldCapture('a')).toBe(true);
  });

  it('treats a different key as a fresh capture and supports explicit timestamps', () => {
    const dedup = createStepCaptureDedup<string>(400, () => 0);
    expect(dedup.shouldCapture('a', 1_000)).toBe(true);
    expect(dedup.shouldCapture('b', 1_100)).toBe(true);
    expect(dedup.shouldCapture('b', 1_200)).toBe(false);
    dedup.reset();
    expect(dedup.shouldCapture('b', 1_250)).toBe(true);
  });
});

describe('createLateClickSuppressor', () => {
  const identity = (armed: string, target: unknown) => armed === target;

  it('suppresses exactly one trusted trailing click inside the window', () => {
    const clock = 0;
    const suppressor = createLateClickSuppressor<string>(2_000, () => clock);
    suppressor.arm('button');
    expect(suppressor.shouldSuppress('button', false, identity)).toBe(false);
    expect(suppressor.shouldSuppress('other', true, identity)).toBe(false);
    expect(suppressor.shouldSuppress('button', true, identity)).toBe(true);
    // Consuming disarms: the next trusted click goes through.
    expect(suppressor.shouldSuppress('button', true, identity)).toBe(false);
  });

  it('expires after the suppression window', () => {
    let clock = 0;
    const suppressor = createLateClickSuppressor<string>(2_000, () => clock);
    suppressor.arm('button');
    clock = 2_000;
    expect(suppressor.shouldSuppress('button', true, identity)).toBe(false);
  });

  it('disarms when a new trusted pointerdown starts a new gesture', () => {
    const clock = 0;
    const suppressor = createLateClickSuppressor<string>(2_000, () => clock);
    suppressor.arm('button');
    suppressor.onTrustedPointerDown();
    expect(suppressor.shouldSuppress('button', true, identity)).toBe(false);
  });

  it('delivers a rapid double-click even when the dedup window declines the capture', () => {
    // Regression: first gesture captured and replayed; suppression armed. The
    // second genuine click landed within DEDUP_MS, so no capture started —
    // but its trusted click used to be eaten by the still-armed suppressor,
    // losing the activation entirely.
    let clock = 0;
    const dedup = createStepCaptureDedup<string>(400, () => clock);
    const suppressor = createLateClickSuppressor<string>(2_000, () => clock);

    // First gesture: pointerdown captured, replay arms suppression.
    expect(dedup.shouldCapture('button')).toBe(true);
    suppressor.arm('button');

    // Second gesture 150ms later on the same element.
    clock = 150;
    suppressor.onTrustedPointerDown();
    expect(dedup.shouldCapture('button')).toBe(false); // no new capture (dedup)
    // The second gesture's trusted click must be delivered, not suppressed.
    expect(suppressor.shouldSuppress('button', true, identity)).toBe(false);
  });

  it('still suppresses the first gesture trailing click that precedes the next pointerdown', () => {
    const clock = 0;
    const suppressor = createLateClickSuppressor<string>(2_000, () => clock);
    suppressor.arm('button');
    // Trailing click of the replayed gesture arrives first (trusted events are
    // ordered), then a new press begins.
    expect(suppressor.shouldSuppress('button', true, identity)).toBe(true);
    suppressor.onTrustedPointerDown();
    expect(suppressor.shouldSuppress('button', true, identity)).toBe(false);
  });
});
