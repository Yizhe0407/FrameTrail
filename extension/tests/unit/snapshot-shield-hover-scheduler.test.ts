import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createHoverScheduler,
  type HoverProbeRequest,
} from '@/entrypoints/snapshot-shield/hover-scheduler';

const HOVER_TIMEOUT_MS = 1_000;
const OFFSET_LIMIT = 8;

function createHarness() {
  const frames = new Map<number, () => void>();
  let nextFrameId = 1;
  const posts: HoverProbeRequest[] = [];
  const state = { enabled: true, capturing: false };
  const scheduler = createHoverScheduler({
    isEnabled: () => state.enabled,
    isCapturing: () => state.capturing,
    post: (request) => posts.push(request),
    hoverTimeoutMs: HOVER_TIMEOUT_MS,
    offsetLimit: OFFSET_LIMIT,
    requestFrame: (callback) => {
      const id = nextFrameId++;
      frames.set(id, callback);
      return id;
    },
    cancelFrame: (id) => {
      frames.delete(id);
    },
  });
  const flushFrames = () => {
    const callbacks = [...frames.values()];
    frames.clear();
    for (const callback of callbacks) callback();
  };
  return { scheduler, posts, state, frames, flushFrames };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('createHoverScheduler', () => {
  it('coalesces input to one frame and keeps at most one probe in flight', () => {
    const { scheduler, posts, frames, flushFrames } = createHarness();
    scheduler.pointerMove(10, 20);
    scheduler.pointerMove(11, 21);
    expect(frames.size).toBe(1);
    flushFrames();
    expect(posts).toEqual([{ requestId: 1, clientX: 11, clientY: 21, candidateOffset: 0 }]);

    // While the probe is pending, new input schedules but never posts.
    scheduler.pointerMove(30, 40);
    flushFrames();
    expect(posts).toHaveLength(1);

    // The stale response releases the slot; the follow-up probe carries the
    // latest point.
    expect(scheduler.resolvePreview({ requestId: 1, candidateOffset: 0 })).toBe('stale');
    scheduler.schedule();
    flushFrames();
    expect(posts).toHaveLength(2);
    expect(posts[1]).toMatchObject({ requestId: 2, clientX: 30, clientY: 40 });
  });

  it('does not re-probe an unchanged point until the sent revision is invalidated', () => {
    const { scheduler, posts, frames, flushFrames } = createHarness();
    scheduler.pointerMove(10, 20);
    flushFrames();
    expect(scheduler.resolvePreview({ requestId: 1, candidateOffset: 3 })).toBe('accepted');
    scheduler.schedule();
    expect(frames.size).toBe(0);
    expect(posts).toHaveLength(1);

    // A settled capture may have changed the page under the cursor: the
    // revision reset forces exactly one fresh probe of the same point, which
    // carries the accepted candidate offset.
    scheduler.invalidateSentRevision();
    scheduler.schedule();
    flushFrames();
    expect(posts).toHaveLength(2);
    expect(posts[1]).toEqual({ requestId: 2, clientX: 10, clientY: 20, candidateOffset: 3 });
  });

  it('abandons an unanswered probe after the timeout and retries; the late response is ignored', () => {
    const { scheduler, posts, flushFrames } = createHarness();
    scheduler.pointerMove(10, 20);
    flushFrames();
    expect(posts).toHaveLength(1);

    vi.advanceTimersByTime(HOVER_TIMEOUT_MS);
    flushFrames();
    expect(posts).toHaveLength(2);
    expect(posts[1]).toMatchObject({ requestId: 2, clientX: 10, clientY: 20 });

    // The original probe's response outlived its timeout: never applied.
    expect(scheduler.resolvePreview({ requestId: 1, candidateOffset: 5 })).toBe('ignored');
  });

  it('rejects responses that no longer match the pending request, latest request, or point', () => {
    const { scheduler, posts, flushFrames } = createHarness();
    scheduler.pointerMove(10, 20);
    flushFrames();

    // Unknown request ids never touch pending state.
    expect(scheduler.resolvePreview({ requestId: 99, candidateOffset: 5 })).toBe('ignored');

    // The point moved after the probe was sent: the response is stale and its
    // candidate offset is not adopted.
    scheduler.pointerMove(30, 40);
    expect(scheduler.resolvePreview({ requestId: 1, candidateOffset: 5 })).toBe('stale');
    scheduler.schedule();
    flushFrames();
    expect(posts[1]).toMatchObject({ clientX: 30, clientY: 40, candidateOffset: 0 });

    // A capture bumped the latest request while this probe was pending.
    const { scheduler: second, posts: secondPosts, flushFrames: flushSecond, state } = createHarness();
    second.pointerMove(10, 20);
    flushSecond();
    expect(secondPosts).toHaveLength(1);
    state.capturing = true;
    second.beginCapture(10, 20);
    state.capturing = false;
    expect(second.resolvePreview({ requestId: 1, candidateOffset: 5 })).toBe('stale');
  });

  it('blocks probing while capturing and while disabled', () => {
    const { scheduler, posts, flushFrames, state } = createHarness();
    state.enabled = false;
    scheduler.pointerMove(10, 20);
    flushFrames();
    expect(posts).toHaveLength(0);

    state.enabled = true;
    state.capturing = true;
    scheduler.pointerMove(10, 20);
    flushFrames();
    expect(posts).toHaveLength(0);
  });

  it('beginCapture cancels scheduled work and resets the offset only when the point moved', () => {
    const { scheduler, posts, frames, flushFrames } = createHarness();
    scheduler.pointerMove(10, 20);
    scheduler.adjustOffset(2);
    expect(frames.size).toBe(1);

    // Committing at the hovered point keeps the cycled candidate offset.
    expect(scheduler.beginCapture(10, 20)).toBe(2);
    flushFrames();
    expect(posts).toHaveLength(0);

    // Committing somewhere else starts from the default candidate.
    expect(scheduler.beginCapture(50, 60)).toBe(0);
  });

  it('clamps keyboard offset cycling to the configured limit', () => {
    const { scheduler } = createHarness();
    scheduler.setAnchor(10, 20);
    for (let i = 0; i < 20; i++) scheduler.adjustOffset(1);
    expect(scheduler.beginCapture(10, 20)).toBe(OFFSET_LIMIT);
    for (let i = 0; i < 40; i++) scheduler.adjustOffset(-1);
    expect(scheduler.beginCapture(10, 20)).toBe(-OFFSET_LIMIT);
  });

  it('clear drops the point and the pending probe', () => {
    const { scheduler, posts, flushFrames } = createHarness();
    scheduler.pointerMove(10, 20);
    flushFrames();
    expect(posts).toHaveLength(1);
    scheduler.clear();
    expect(scheduler.hasPoint()).toBe(false);
    expect(scheduler.resolvePreview({ requestId: 1, candidateOffset: 0 })).toBe('ignored');
    scheduler.schedule();
    flushFrames();
    expect(posts).toHaveLength(1);
  });
});
