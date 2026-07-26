import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  KEEPALIVE_REJECTED_MESSAGE_TYPE,
  startKeepAlive,
  type KeepAlivePortLike,
} from '@/lib/runtime/keep-alive';
import { silenceIntentionalErrorLogs } from '../setup/silence-intentional-logs';

function port(): KeepAlivePortLike & {
  disconnect: ReturnType<typeof vi.fn>;
  emitDisconnect(): void;
  emitMessage(message: unknown): void;
} {
  let listener: (() => void) | undefined;
  let messageListener: ((message: unknown) => void) | undefined;
  const result = {
    postMessage: vi.fn(),
    disconnect: vi.fn(() => listener?.()),
    onMessage: {
      addListener: (next: (message: unknown) => void) => {
        messageListener = next;
      },
    },
    onDisconnect: {
      addListener: (next: () => void) => {
        listener = next;
      },
    },
    emitDisconnect: () => listener?.(),
    emitMessage: (message: unknown) => messageListener?.(message),
  };
  return result;
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('startKeepAlive', () => {
  it('backs off after connect failures instead of recursively spinning', () => {
    silenceIntentionalErrorLogs();
    vi.useFakeTimers();
    const first = port();
    const connect = vi.fn()
      .mockImplementationOnce(() => {
        throw new Error('extension reloading');
      })
      .mockImplementationOnce(() => first);
    const handle = startKeepAlive(
      { connect },
      { name: 'test', intervalMs: 100, initialReconnectDelayMs: 10 },
    );

    expect(connect).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(9);
    expect(connect).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(1);
    expect(connect).toHaveBeenCalledTimes(2);
    handle.stop();
  });

  it('reconnects a disconnected port with a delay and never uses a stale port', () => {
    vi.useFakeTimers();
    const first = port();
    const second = port();
    const connect = vi.fn().mockReturnValueOnce(first).mockReturnValueOnce(second);
    const handle = startKeepAlive(
      { connect },
      { name: 'test', intervalMs: 100, initialReconnectDelayMs: 20 },
    );

    first.emitDisconnect();
    vi.advanceTimersByTime(19);
    expect(connect).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(1);
    expect(connect).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(100);
    expect(first.postMessage).not.toHaveBeenCalled();
    expect(second.postMessage).toHaveBeenCalledWith({ type: 'heartbeat' });
    handle.stop();
  });

  it('backs off repeated short-lived connections until a heartbeat succeeds', () => {
    vi.useFakeTimers();
    const first = port();
    const second = port();
    const third = port();
    const fourth = port();
    const connect = vi.fn()
      .mockReturnValueOnce(first)
      .mockReturnValueOnce(second)
      .mockReturnValueOnce(third)
      .mockReturnValueOnce(fourth);
    const handle = startKeepAlive(
      { connect },
      { name: 'test', intervalMs: 100, initialReconnectDelayMs: 10 },
    );

    first.emitDisconnect();
    vi.advanceTimersByTime(10);
    second.emitDisconnect();
    vi.advanceTimersByTime(19);
    expect(connect).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(1);
    expect(connect).toHaveBeenCalledTimes(3);

    vi.advanceTimersByTime(100);
    expect(third.postMessage).toHaveBeenCalledWith({ type: 'heartbeat' });
    third.emitDisconnect();
    vi.advanceTimersByTime(9);
    expect(connect).toHaveBeenCalledTimes(3);
    vi.advanceTimersByTime(1);
    expect(connect).toHaveBeenCalledTimes(4);
    handle.stop();
  });

  it('reconnects when a heartbeat throws and stop cancels future retries', () => {
    silenceIntentionalErrorLogs();
    vi.useFakeTimers();
    const first = port();
    const firstPost = vi.spyOn(first, 'postMessage');
    firstPost.mockImplementation(() => {
      throw new Error('disconnected');
    });
    const second = port();
    const connect = vi.fn().mockReturnValueOnce(first).mockReturnValueOnce(second);
    const handle = startKeepAlive(
      { connect },
      { name: 'test', intervalMs: 10, initialReconnectDelayMs: 5 },
    );

    vi.advanceTimersByTime(10);
    expect(first.disconnect).toHaveBeenCalledOnce();
    handle.stop();
    vi.advanceTimersByTime(100);
    expect(connect).toHaveBeenCalledOnce();
  });

  it('stops for good and notifies onRejected when the background rejects the port', () => {
    vi.useFakeTimers();
    const first = port();
    const connect = vi.fn().mockReturnValue(first);
    const onRejected = vi.fn();
    startKeepAlive(
      { connect },
      { name: 'test', intervalMs: 100, initialReconnectDelayMs: 10, onRejected },
    );

    first.emitMessage({ type: 'unrelated' });
    expect(onRejected).not.toHaveBeenCalled();

    first.emitMessage({ type: KEEPALIVE_REJECTED_MESSAGE_TYPE });
    expect(onRejected).toHaveBeenCalledOnce();
    expect(first.disconnect).toHaveBeenCalledOnce();

    // The background's follow-up disconnect and any amount of time must not
    // schedule another connection for an authoritatively rejected client.
    first.emitDisconnect();
    vi.advanceTimersByTime(60_000);
    expect(connect).toHaveBeenCalledOnce();
  });

  it('gives up after consecutive failed connection cycles without a heartbeat', () => {
    silenceIntentionalErrorLogs();
    vi.useFakeTimers();
    const first = port();
    const second = port();
    const third = port();
    const connect = vi.fn()
      .mockReturnValueOnce(first)
      .mockReturnValueOnce(second)
      .mockReturnValueOnce(third);
    const onRejected = vi.fn();
    startKeepAlive(
      { connect },
      {
        name: 'test',
        intervalMs: 100,
        initialReconnectDelayMs: 10,
        maxConsecutiveFailures: 2,
        onRejected,
      },
    );

    first.emitDisconnect();
    vi.advanceTimersByTime(10);
    second.emitDisconnect();
    vi.advanceTimersByTime(20);
    expect(connect).toHaveBeenCalledTimes(3);
    expect(onRejected).not.toHaveBeenCalled();

    third.emitDisconnect();
    expect(onRejected).toHaveBeenCalledOnce();
    expect(third.disconnect).not.toHaveBeenCalled();
    vi.advanceTimersByTime(60_000);
    expect(connect).toHaveBeenCalledTimes(3);
  });
});
