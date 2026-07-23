import { afterEach, describe, expect, it, vi } from 'vitest';
import { startKeepAlive, type KeepAlivePortLike } from '@/lib/keep-alive';

function port(): KeepAlivePortLike & {
  disconnect: ReturnType<typeof vi.fn>;
  emitDisconnect(): void;
} {
  let listener: (() => void) | undefined;
  const result = {
    postMessage: vi.fn(),
    disconnect: vi.fn(() => listener?.()),
    onDisconnect: {
      addListener: (next: () => void) => {
        listener = next;
      },
    },
    emitDisconnect: () => listener?.(),
  };
  return result;
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('startKeepAlive', () => {
  it('backs off after connect failures instead of recursively spinning', () => {
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
});
