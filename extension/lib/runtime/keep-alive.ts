/** Posted by the background on a keep-alive port it refuses to serve, right
 * before disconnecting it. It authoritatively tells the client its capture job
 * no longer exists, unlike a bare disconnect which may just be a transient
 * service-worker restart. */
export const KEEPALIVE_REJECTED_MESSAGE_TYPE = 'frametrail-keepalive-rejected';

export function isKeepAliveRejectionMessage(message: unknown): boolean {
  return (
    typeof message === 'object' &&
    message !== null &&
    (message as { type?: unknown }).type === KEEPALIVE_REJECTED_MESSAGE_TYPE
  );
}

export interface KeepAlivePortLike {
  postMessage(message: unknown): void;
  disconnect(): void;
  onMessage: { addListener(listener: (message: unknown) => void): void };
  onDisconnect: { addListener(listener: () => void): void };
}

export interface KeepAliveRuntimeLike {
  connect(options: { name: string }): KeepAlivePortLike;
}

export interface KeepAliveOptions {
  name: string;
  intervalMs: number;
  initialReconnectDelayMs?: number;
  maxReconnectDelayMs?: number;
  /** Consecutive failed connection cycles (no heartbeat ever succeeding)
   * tolerated before the client gives up instead of reconnecting forever. */
  maxConsecutiveFailures?: number;
  /** Invoked once when the background rejects this client or reconnection
   * fails maxConsecutiveFailures times in a row; the handle is already
   * stopped, so the caller only needs to tear down its own UI. */
  onRejected?: () => void;
}

export interface KeepAliveHandle {
  stop(): void;
}

const DEFAULT_MAX_CONSECUTIVE_FAILURES = 10;

/**
 * Keeps a long-running extension operation alive without recursive reconnects.
 * Browser runtime ports can throw while an extension is being reloaded and can
 * also throw when a stale port is used, so every boundary is guarded and
 * reconnection is scheduled with bounded exponential backoff.
 *
 * An orphaned client must not wake the service worker forever: an explicit
 * rejection message from the background stops the client immediately, and a
 * bounded run of consecutive failures without one successful heartbeat stops
 * it as defense in depth (an older background may disconnect silently).
 */
export function startKeepAlive(
  runtime: KeepAliveRuntimeLike,
  options: KeepAliveOptions,
): KeepAliveHandle {
  const initialReconnectDelayMs = Math.max(1, options.initialReconnectDelayMs ?? 250);
  const maxReconnectDelayMs = Math.max(initialReconnectDelayMs, options.maxReconnectDelayMs ?? 10_000);
  const intervalMs = Math.max(1, options.intervalMs);
  const maxConsecutiveFailures = Math.max(1, options.maxConsecutiveFailures ?? DEFAULT_MAX_CONSECUTIVE_FAILURES);

  let stopped = false;
  let port: KeepAlivePortLike | null = null;
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let reconnectAttempt = 0;

  const clearHeartbeat = () => {
    if (heartbeatTimer !== null) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
  };

  const clearReconnect = () => {
    if (reconnectTimer !== null) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  };

  const giveUp = () => {
    if (stopped) return;
    stop();
    try {
      options.onRejected?.();
    } catch (error) {
      console.error('[frametrail] keep-alive rejection handler failed', error);
    }
  };

  const scheduleReconnect = () => {
    if (stopped || reconnectTimer !== null) return;
    if (reconnectAttempt >= maxConsecutiveFailures) {
      console.warn('[frametrail] keep-alive gave up after repeated failed reconnects');
      giveUp();
      return;
    }
    const delay = Math.min(
      maxReconnectDelayMs,
      initialReconnectDelayMs * 2 ** Math.min(reconnectAttempt, 10),
    );
    reconnectAttempt++;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, delay);
  };

  const disconnectCurrent = (expectedPort: KeepAlivePortLike) => {
    if (port !== expectedPort) return;
    port = null;
    clearHeartbeat();
    if (!stopped) scheduleReconnect();
  };

  const connect = () => {
    if (stopped || port !== null) return;
    let nextPort: KeepAlivePortLike;
    try {
      nextPort = runtime.connect({ name: options.name });
    } catch (error) {
      console.warn('[frametrail] keep-alive connection failed; retrying', error);
      scheduleReconnect();
      return;
    }

    port = nextPort;
    nextPort.onDisconnect.addListener(() => disconnectCurrent(nextPort));
    nextPort.onMessage.addListener((message) => {
      if (stopped || port !== nextPort || !isKeepAliveRejectionMessage(message)) return;
      giveUp();
    });

    const heartbeat = () => {
      if (stopped || port !== nextPort) return;
      try {
        nextPort.postMessage({ type: 'heartbeat' });
        reconnectAttempt = 0;
      } catch (error) {
        console.warn('[frametrail] keep-alive heartbeat failed; reconnecting', error);
        try {
          nextPort.disconnect();
        } catch {
          // The runtime may already have invalidated the port.
        }
        disconnectCurrent(nextPort);
      }
    };
    heartbeatTimer = setInterval(heartbeat, intervalMs);
  };

  const stop = () => {
    if (stopped) return;
    stopped = true;
    clearHeartbeat();
    clearReconnect();
    const current = port;
    port = null;
    if (current) {
      try {
        current.disconnect();
      } catch {
        // The runtime may already have disconnected this port.
      }
    }
  };

  connect();
  return { stop };
}
