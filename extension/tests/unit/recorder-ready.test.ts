import { afterEach, describe, expect, it, vi } from 'vitest';
import { RecorderReadyGate } from '@/lib/recording/recorder-ready';

const expected = {
  runId: 'run-1',
  tabId: 7,
  controlVersion: 3,
};

afterEach(() => vi.useRealTimers());

describe('RecorderReadyGate', () => {
  it('only accepts readiness from the exact recording run', async () => {
    vi.useFakeTimers();
    const gate = new RecorderReadyGate(expected, 5_000);

    expect(gate.signal({ ...expected, runId: 'run-2' })).toBe(false);
    expect(gate.signal({ ...expected, tabId: 8 })).toBe(false);
    expect(gate.signal({ ...expected, controlVersion: 4 })).toBe(false);
    expect(gate.signal(expected)).toBe(true);
    await expect(gate.promise).resolves.toBe(true);
    expect(gate.signal(expected)).toBe(false);
    expect(gate.matches(expected)).toBe(true);
    expect(gate.matches({ ...expected, runId: 'run-2' })).toBe(false);
  });

  it('fails closed when the recorder never becomes ready', async () => {
    vi.useFakeTimers();
    const gate = new RecorderReadyGate(expected, 5_000);

    await vi.advanceTimersByTimeAsync(5_000);

    await expect(gate.promise).resolves.toBe(false);
  });
});
