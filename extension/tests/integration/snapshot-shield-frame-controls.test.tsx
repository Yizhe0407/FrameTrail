// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  SNAPSHOT_SHIELD_INIT,
  SNAPSHOT_SHIELD_POINTER_DOWN,
  SNAPSHOT_SHIELD_POINTER_MOVE,
  SNAPSHOT_SHIELD_TOOLBAR_STATE,
  type SnapshotShieldFrameMessage,
} from '@/lib/recording/snapshot-shield-protocol';

const mocks = vi.hoisted(() => ({ render: vi.fn() }));

vi.mock('react-dom/client', () => ({
  createRoot: () => ({ render: mocks.render }),
}));
vi.mock('@/components/recording/RecordingToolbar', () => ({ default: () => null }));

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

describe('snapshot shield frame controls', () => {
  it('releases timed-out captures and settles failed toolbar commands', async () => {
    vi.useFakeTimers();
    window.history.replaceState({}, '', '/snapshot-shield.html?token=test-token');
    const port = {
      onmessage: null as ((event: MessageEvent<SnapshotShieldFrameMessage>) => void) | null,
      onmessageerror: null as (() => void) | null,
      postMessage: vi.fn(),
      start: vi.fn(),
    };

    await import('@/entrypoints/snapshot-shield/main');
    window.dispatchEvent(
      new MessageEvent('message', {
        source: window,
        data: { type: SNAPSHOT_SHIELD_INIT, token: 'test-token' },
        ports: [port as unknown as MessagePort],
      }),
    );

    port.onmessage?.({
      data: {
        type: SNAPSHOT_SHIELD_TOOLBAR_STATE,
        token: 'test-token',
        state: {
          runId: 'run-1',
          mode: 'snapshot',
          phase: 'recording',
          itemCount: 0,
          error: null,
        },
      },
    } as MessageEvent<SnapshotShieldFrameMessage>);

    const toolbar = mocks.render.mock.lastCall?.[0] as {
      props: { onCommand(action: string): Promise<unknown> };
    };

    window.dispatchEvent(new MouseEvent('pointermove', { clientX: 20, clientY: 30 }));
    await vi.advanceTimersByTimeAsync(16);
    expect(port.postMessage.mock.calls.filter(
      ([message]) => message.type === SNAPSHOT_SHIELD_POINTER_MOVE,
    )).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(4_016);
    expect(port.postMessage.mock.calls.filter(
      ([message]) => message.type === SNAPSHOT_SHIELD_POINTER_MOVE,
    )).toHaveLength(2);

    const pointerDown = new MouseEvent('pointerdown', {
      bubbles: true,
      cancelable: true,
      button: 0,
      clientX: 40,
      clientY: 50,
    });
    Object.defineProperty(pointerDown, 'isPrimary', { value: true });
    document.body.dispatchEvent(pointerDown);
    const firstCaptureCount = port.postMessage.mock.calls.filter(
      ([message]) => message.type === SNAPSHOT_SHIELD_POINTER_DOWN,
    ).length;
    expect(firstCaptureCount).toBe(1);
    await vi.advanceTimersByTimeAsync(30_000);
    const secondPointerDown = new MouseEvent('pointerdown', {
      bubbles: true,
      cancelable: true,
      button: 0,
      clientX: 45,
      clientY: 55,
    });
    Object.defineProperty(secondPointerDown, 'isPrimary', { value: true });
    document.body.dispatchEvent(secondPointerDown);
    expect(port.postMessage.mock.calls.filter(
      ([message]) => message.type === SNAPSHOT_SHIELD_POINTER_DOWN,
    )).toHaveLength(2);

    const timedOut = toolbar.props.onCommand('PAUSE_RECORDING');
    await vi.advanceTimersByTimeAsync(15_000);
    await expect(timedOut).resolves.toEqual(expect.objectContaining({ ok: false }));

    port.postMessage.mockImplementationOnce(() => {
      throw new Error('port closed');
    });
    const failed = toolbar.props.onCommand('PAUSE_RECORDING');
    await expect(failed).resolves.toEqual(expect.objectContaining({ ok: false }));
  });
});
