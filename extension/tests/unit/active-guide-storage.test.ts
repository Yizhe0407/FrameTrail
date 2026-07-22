import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const values: Record<string, unknown> = {};
  const listeners = new Set<(changes: Record<string, { oldValue?: unknown; newValue?: unknown }>, area: string) => void>();
  const local = {
    get: vi.fn(async (key: string) => ({ [key]: values[key] })),
    set: vi.fn(async (items: Record<string, unknown>) => {
      Object.assign(values, items);
    }),
    remove: vi.fn(async (key: string) => {
      delete values[key];
    }),
  };
  return {
    values,
    listeners,
    local,
    addListener: vi.fn((listener: (changes: Record<string, { newValue?: unknown }>, area: string) => void) => {
      listeners.add(listener);
    }),
    removeListener: vi.fn((listener: (changes: Record<string, { newValue?: unknown }>, area: string) => void) => {
      listeners.delete(listener);
    }),
  };
});

vi.mock('wxt/browser', () => ({
  browser: {
    storage: {
      local: mocks.local,
      onChanged: {
        addListener: mocks.addListener,
        removeListener: mocks.removeListener,
      },
    },
  },
}));

import {
  ACTIVE_GUIDE_ID_KEY,
  clearActiveGuideId,
  getActiveGuideId,
  onActiveGuideIdChange,
  setActiveGuideId,
} from '@/lib/storage';
import { RECORDING_STATE_KEY } from '@/lib/messages';

beforeEach(() => {
  for (const key of Object.keys(mocks.values)) delete mocks.values[key];
  mocks.local.get.mockClear();
  mocks.local.set.mockClear();
  mocks.local.remove.mockClear();
  mocks.addListener.mockClear();
  mocks.removeListener.mockClear();
  mocks.listeners.clear();
});

describe('active Guide storage', () => {
  it('stores UI selection under an independent key without touching RecordingState', async () => {
    await setActiveGuideId('guide-a');

    expect(ACTIVE_GUIDE_ID_KEY).not.toBe(RECORDING_STATE_KEY);
    expect(mocks.local.set).toHaveBeenCalledWith({ [ACTIVE_GUIDE_ID_KEY]: 'guide-a' });
    expect(mocks.values[RECORDING_STATE_KEY]).toBeUndefined();
    await expect(getActiveGuideId()).resolves.toBe('guide-a');
  });

  it('compare-and-clears only the expected selection', async () => {
    mocks.values[ACTIVE_GUIDE_ID_KEY] = 'guide-b';

    await expect(clearActiveGuideId('guide-a')).resolves.toBe(false);
    expect(mocks.local.remove).not.toHaveBeenCalled();
    expect(mocks.values[ACTIVE_GUIDE_ID_KEY]).toBe('guide-b');

    await expect(clearActiveGuideId('guide-b')).resolves.toBe(true);
    expect(mocks.local.remove).toHaveBeenCalledWith(ACTIVE_GUIDE_ID_KEY);
    expect(mocks.values[ACTIVE_GUIDE_ID_KEY]).toBeUndefined();
  });

  it('serializes a clear followed by a newer select so the newer selection survives', async () => {
    mocks.values[ACTIVE_GUIDE_ID_KEY] = 'guide-a';
    let releaseRead!: () => void;
    const blockedRead = new Promise<void>((resolve) => { releaseRead = resolve; });
    mocks.local.get.mockImplementationOnce(async (key: string) => {
      await blockedRead;
      return { [key]: mocks.values[key] };
    });

    const clearing = clearActiveGuideId('guide-a');
    const selecting = setActiveGuideId('guide-b');
    releaseRead();
    await Promise.all([clearing, selecting]);

    expect(mocks.values[ACTIVE_GUIDE_ID_KEY]).toBe('guide-b');
    expect(mocks.local.remove.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.local.set.mock.invocationCallOrder[0],
    );
  });

  it('subscribes only to local active-selection changes and normalizes removal', () => {
    const callback = vi.fn();
    const unsubscribe = onActiveGuideIdChange(callback);
    const [listener] = mocks.listeners;

    listener?.({ [ACTIVE_GUIDE_ID_KEY]: { newValue: 'guide-a' } }, 'sync');
    listener?.({ [RECORDING_STATE_KEY]: { newValue: {} } }, 'local');
    listener?.({ [ACTIVE_GUIDE_ID_KEY]: { newValue: 'guide-a' } }, 'local');
    listener?.({ [ACTIVE_GUIDE_ID_KEY]: { newValue: undefined } }, 'local');

    expect(callback.mock.calls).toEqual([['guide-a'], [null]]);
    unsubscribe();
    expect(mocks.removeListener).toHaveBeenCalledOnce();
  });
});
