import { useCallback, useEffect, useRef, useState } from 'react';
import { getRecordingState, onRecordingStateChange } from './storage';
import { getSteps, type Step } from './db';

/** Screenshot blobs are immutable after a step is created. IndexedDB returns
 * a fresh Blob wrapper on every read; retaining the existing wrapper prevents
 * image object URLs from being revoked and reloaded after unrelated edits. */
export function reconcileSteps(previous: Step[], next: Step[]): Step[] {
  const previousById = new Map(previous.map((step) => [step.id, step]));
  const reconciled = next.map((step) => {
    const previousStep = previousById.get(step.id);
    if (!previousStep) return step;
    const boundsMatch =
      previousStep.bounds === step.bounds ||
      (previousStep.bounds !== null &&
        step.bounds !== null &&
        previousStep.bounds.x === step.bounds.x &&
        previousStep.bounds.y === step.bounds.y &&
        previousStep.bounds.width === step.bounds.width &&
        previousStep.bounds.height === step.bounds.height);
    const metadataMatch =
      previousStep.sessionId === step.sessionId &&
      previousStep.order === step.order &&
      boundsMatch &&
      previousStep.devicePixelRatio === step.devicePixelRatio &&
      previousStep.screenshotScale === step.screenshotScale &&
      previousStep.description === step.description &&
      previousStep.url === step.url &&
      previousStep.timestamp === step.timestamp &&
      previousStep.groupId === step.groupId &&
      previousStep.numbered === step.numbered &&
      Boolean(previousStep.screenshotBlob) === Boolean(step.screenshotBlob);
    if (metadataMatch) return previousStep;
    if (!step.screenshotBlob || !previousStep.screenshotBlob) return step;
    return { ...step, screenshotBlob: previousStep.screenshotBlob };
  });
  return reconciled.length === previous.length && reconciled.every((step, index) => step === previous[index])
    ? previous
    : reconciled;
}

/** Shared popup/editor state: current recording status, steps, and any error. */
export function useRecordingSession() {
  const [isRecording, setIsRecording] = useState(false);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [steps, setSteps] = useState<Step[]>([]);
  const [error, setError] = useState<string | null>(null);
  const latestStepsRequest = useRef(0);

  const refreshSteps = useCallback(async (sid: string | null) => {
    const request = ++latestStepsRequest.current;
    const nextSteps = sid ? await getSteps(sid) : [];
    if (request === latestStepsRequest.current) {
      setSteps((previous) => reconcileSteps(previous, nextSteps));
    }
  }, []);

  useEffect(() => {
    let disposed = false;
    let stateVersion = 0;

    const applyState = (state: Awaited<ReturnType<typeof getRecordingState>>) => {
      if (disposed) return;
      setIsRecording(state.isRecording);
      setSessionId(state.sessionId);
      setError(state.error);
      void refreshSteps(state.sessionId);
    };

    const initialVersion = stateVersion;
    void getRecordingState().then((state) => {
      // A storage change can arrive while the initial read is pending. Its
      // newer state wins even if the older read resolves last.
      if (stateVersion === initialVersion) applyState(state);
    });

    const unsubscribe = onRecordingStateChange((state) => {
      stateVersion++;
      applyState(state);
    });

    return () => {
      disposed = true;
      latestStepsRequest.current++;
      unsubscribe();
    };
  }, [refreshSteps]);

  // Background writes new steps to IndexedDB independently of the UI;
  // poll while recording so the list updates without a custom pub/sub channel.
  useEffect(() => {
    if (!isRecording || !sessionId) return;
    const interval = setInterval(() => refreshSteps(sessionId), 1000);
    return () => clearInterval(interval);
  }, [isRecording, sessionId, refreshSteps]);

  return { isRecording, sessionId, steps, error, refresh: () => refreshSteps(sessionId) };
}
