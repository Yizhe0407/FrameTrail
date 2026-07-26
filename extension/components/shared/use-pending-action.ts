import { useCallback, useRef, useState } from 'react';

/**
 * Ref-gated single-flight action runner. State updates are asynchronous, so a
 * pending key alone cannot stop two actions fired in the same event turn from
 * overlapping; the ref answers synchronously while `pendingKey` drives the UI
 * (spinners, disabled controls).
 *
 * `runExclusive` resolves `undefined` when another action already holds the
 * gate. Failures are the caller's to catch — the gate only guarantees release.
 */
export function usePendingAction<K = string>() {
  const [pendingKey, setPendingKey] = useState<K | null>(null);
  const inFlight = useRef(false);

  const runExclusive = useCallback(async <T,>(key: K, action: () => Promise<T>): Promise<T | undefined> => {
    if (inFlight.current) return undefined;
    inFlight.current = true;
    setPendingKey(key);
    try {
      return await action();
    } finally {
      inFlight.current = false;
      setPendingKey(null);
    }
  }, []);

  return { pendingKey, runExclusive };
}
