import { describe, expect, it, vi } from 'vitest';
import { installBfcacheLifecycle, type BfcacheLifecycleTarget } from '@/lib/recording/bfcache-lifecycle';

function fakeWindow(): BfcacheLifecycleTarget & {
  emit(type: 'pagehide' | 'pageshow', persisted: boolean): void;
  listenerCount(): number;
} {
  const listeners = new Map<string, Set<(event: Event) => void>>();
  return {
    addEventListener(type, listener) {
      const set = listeners.get(type) ?? new Set();
      set.add(listener);
      listeners.set(type, set);
    },
    removeEventListener(type, listener) {
      listeners.get(type)?.delete(listener);
    },
    emit(type, persisted) {
      const event = { type, persisted } as unknown as Event;
      for (const listener of listeners.get(type) ?? []) listener(event);
    },
    listenerCount() {
      let count = 0;
      for (const set of listeners.values()) count += set.size;
      return count;
    },
  };
}

function harness(isRunCurrent: () => Promise<boolean>) {
  const target = fakeWindow();
  const suspend = vi.fn();
  const resume = vi.fn();
  const teardown = vi.fn();
  const uninstall = installBfcacheLifecycle({ target, suspend, resume, isRunCurrent, teardown });
  return { target, suspend, resume, teardown, uninstall };
}

describe('installBfcacheLifecycle', () => {
  it('hands the keep-alive port back on pagehide before the document freezes', () => {
    const { target, suspend, resume, teardown } = harness(async () => true);
    target.emit('pagehide', true);
    expect(suspend).toHaveBeenCalledOnce();
    expect(resume).not.toHaveBeenCalled();
    expect(teardown).not.toHaveBeenCalled();
  });

  it('resumes the port when a bfcache restore finds the run still live', async () => {
    const { target, resume, teardown } = harness(async () => true);
    target.emit('pageshow', true);
    await vi.waitFor(() => expect(resume).toHaveBeenCalledOnce());
    expect(teardown).not.toHaveBeenCalled();
  });

  it('tears the restored recorder down when its run has moved on', async () => {
    const { target, resume, teardown } = harness(async () => false);
    target.emit('pageshow', true);
    await vi.waitFor(() => expect(teardown).toHaveBeenCalledOnce());
    expect(resume).not.toHaveBeenCalled();
  });

  it('ignores the initial non-persisted pageshow', async () => {
    const isRunCurrent = vi.fn(async () => true);
    const { target, resume, teardown } = harness(isRunCurrent);
    target.emit('pageshow', false);
    await Promise.resolve();
    expect(isRunCurrent).not.toHaveBeenCalled();
    expect(resume).not.toHaveBeenCalled();
    expect(teardown).not.toHaveBeenCalled();
  });

  it('resumes when the state read fails, leaving the keep-alive rejection as backstop', async () => {
    const { target, resume, teardown } = harness(async () => {
      throw new Error('storage unavailable');
    });
    target.emit('pageshow', true);
    await vi.waitFor(() => expect(resume).toHaveBeenCalledOnce());
    expect(teardown).not.toHaveBeenCalled();
  });

  it('uninstall removes both listeners', () => {
    const { target, suspend, uninstall } = harness(async () => true);
    expect(target.listenerCount()).toBe(2);
    uninstall();
    expect(target.listenerCount()).toBe(0);
    target.emit('pagehide', true);
    expect(suspend).not.toHaveBeenCalled();
  });
});
