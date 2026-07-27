/** Canonical name of the recorder's keep-alive port. The background accepts
 * only ports carrying this exact name; both sides import it from here. */
export const KEEPALIVE_PORT_NAME = 'frametrail-keepalive';

/** Posted by the background on a keep-alive port it refuses to serve, right
 * before disconnecting it. It authoritatively tells the client its capture job
 * no longer exists, unlike a bare disconnect which may just be a transient
 * service-worker restart. */
export const KEEPALIVE_REJECTED_MESSAGE_TYPE = 'frametrail-keepalive-rejected';

function isKeepAliveRejectionMessage(message: unknown): boolean {
  return (
    typeof message === 'object' &&
    message !== null &&
    (message as { type?: unknown }).type === KEEPALIVE_REJECTED_MESSAGE_TYPE
  );
}

function isKeepAliveHeartbeat(message: unknown): boolean {
  return (
    typeof message === 'object' &&
    message !== null &&
    (message as { type?: unknown }).type === 'heartbeat'
  );
}

/** Background-side view of a runtime.onConnect port. */
/** The half of a runtime port both ends of the keep-alive use. */
export interface KeepAlivePortLike {
  postMessage(message: unknown): void;
  disconnect(): void;
  onMessage: { addListener(listener: (message: unknown) => void): void };
  onDisconnect: { addListener(listener: () => void): void };
}

export interface KeepAliveServerPortLike<TSender = unknown> extends KeepAlivePortLike {
  name: string;
  sender?: TSender;
}

export interface KeepAlivePortHandlerDeps<TSender, TState> {
  getRecordingState(): Promise<TState>;
  /** Trust check binding the port's sender to the active capture job; receives
   * `undefined` when the runtime reports no sender. */
  isTrustedKeepAliveSender(sender: TSender | undefined, state: TState): boolean;
  /** Invoked on disconnect to read runtime.lastError. A recorded page that
   * navigates hands its port to the back/forward cache, which closes the
   * channel with a lastError; acknowledging it stops Chrome from logging
   * "Unchecked runtime.lastError" for every recorded-page navigation. */
  acknowledgeDisconnect(): void;
}

/**
 * Background half of the keep-alive protocol: serves ports carrying
 * KEEPALIVE_PORT_NAME and authorizes them against the active capture job.
 * An authoritative rejection tells the client its capture job is over so it
 * tears its UI down, instead of mistaking the disconnect for a worker restart
 * and reconnecting (and waking the worker) forever. The onConnect listener
 * itself stays wired in the background entrypoint.
 */
export function createKeepAlivePortHandler<TSender, TState>(
  deps: KeepAlivePortHandlerDeps<TSender, TState>,
): (port: KeepAliveServerPortLike<TSender>) => void {
  return (port) => {
    if (port.name !== KEEPALIVE_PORT_NAME) return;
    let disconnected = false;
    const disconnect = () => {
      if (disconnected) return;
      disconnected = true;
      try {
        port.disconnect();
      } catch {
        // The sender may already have disappeared during authorization.
      }
    };
    const reject = () => {
      if (disconnected) return;
      try {
        port.postMessage({ type: KEEPALIVE_REJECTED_MESSAGE_TYPE });
      } catch {
        // The port may already be gone; the client's give-up cap still applies.
      }
      disconnect();
    };
    const authorize = () => {
      void deps.getRecordingState().then((state) => {
        if (!disconnected && !deps.isTrustedKeepAliveSender(port.sender, state)) reject();
      }).catch((error) => {
        // Reading state failed, which says nothing about the sender: drop the
        // port without the rejection message so a healthy recorder reconnects.
        console.error('[frametrail] failed to authorize keep-alive port', error);
        disconnect();
      });
    };
    port.onDisconnect.addListener(() => {
      disconnected = true;
      deps.acknowledgeDisconnect();
    });
    port.onMessage.addListener((message) => {
      if (!isKeepAliveHeartbeat(message)) {
        reject();
        return;
      }
      authorize();
    });
    authorize();
  };
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
  /**
   * Closes the port cleanly without counting toward the give-up cap. Used on
   * pagehide: a page that enters the back/forward cache with a live extension
   * port makes the browser kill the channel and surface an "Unchecked
   * runtime.lastError" in the service worker, so the client hands the port
   * back before the document is frozen.
   */
  suspend(): void;
  /** Re-establishes the port after a suspend (pageshow). No-op unless
   * suspended; backoff state restarts from zero because a restore from the
   * cache says nothing about background health. */
  resume(): void;
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
  let suspended = false;
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
    if (stopped || suspended || reconnectTimer !== null) return;
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
    if (stopped || suspended || port !== null) return;
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

  const closeCurrentPort = () => {
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

  const stop = () => {
    if (stopped) return;
    stopped = true;
    clearHeartbeat();
    clearReconnect();
    closeCurrentPort();
  };

  const suspend = () => {
    if (stopped || suspended) return;
    suspended = true;
    clearHeartbeat();
    clearReconnect();
    // A clean hand-back is not a failure; the next resume starts fresh.
    reconnectAttempt = 0;
    closeCurrentPort();
  };

  const resume = () => {
    if (stopped || !suspended) return;
    suspended = false;
    reconnectAttempt = 0;
    connect();
  };

  connect();
  return { stop, suspend, resume };
}
