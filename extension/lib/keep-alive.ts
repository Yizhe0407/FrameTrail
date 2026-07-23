export interface KeepAlivePortLike {
  postMessage(message: unknown): void;
  disconnect(): void;
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
}

export interface KeepAliveHandle {
  stop(): void;
}

/**
 * Keeps a long-running extension operation alive without recursive reconnects.
 * Browser runtime ports can throw while an extension is being reloaded and can
 * also throw when a stale port is used, so every boundary is guarded and
 * reconnection is scheduled with bounded exponential backoff.
 */
export function startKeepAlive(
  runtime: KeepAliveRuntimeLike,
  options: KeepAliveOptions,
): KeepAliveHandle {
  const initialReconnectDelayMs = Math.max(1, options.initialReconnectDelayMs ?? 250);
  const maxReconnectDelayMs = Math.max(initialReconnectDelayMs, options.maxReconnectDelayMs ?? 10_000);
  const intervalMs = Math.max(1, options.intervalMs);

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

  const scheduleReconnect = () => {
    if (stopped || reconnectTimer !== null) return;
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
