import { useCallback, useEffect, useRef, useState } from 'react';
import { createDefaultRecordingState, getRecordingState, onRecordingStateChange } from './storage';
import { getSteps, type Step } from './db';


function boundsMatch(
  first: Step['bounds'] | Step['manualBounds'],
  second: Step['bounds'] | Step['manualBounds'],
): boolean {
  return (
    first === second ||
    (first != null &&
      second != null &&
      first.x === second.x &&
      first.y === second.y &&
      first.width === second.width &&
      first.height === second.height)
  );
}

function redactionsMatch(first: Step['redactions'], second: Step['redactions']): boolean {
  if (first === second) return true;
  if (!first || !second || first.length !== second.length) return false;
  return first.every((redaction, index) => {
    const other = second[index];
    return (
      redaction.id === other.id &&
      redaction.kind === other.kind &&
      boundsMatch(redaction.bounds, other.bounds)
    );
  });
}

/** IndexedDB returns a fresh Blob wrapper on every read. Keep the existing
 * wrapper only while captureRevision is unchanged; recapture deliberately
 * increments that revision so every image consumer receives the replacement. */
export function reconcileSteps(previous: Step[], next: Step[]): Step[] {
  const previousById = new Map(previous.map((step) => [step.id, step]));
  const reconciled = next.map((step) => {
    const previousStep = previousById.get(step.id);
    if (!previousStep) return step;
    const metadataMatch =
      previousStep.sessionId === step.sessionId &&
      previousStep.order === step.order &&
      boundsMatch(previousStep.bounds, step.bounds) &&
      boundsMatch(previousStep.manualBounds, step.manualBounds) &&
      redactionsMatch(previousStep.redactions, step.redactions) &&
      previousStep.redactionReviewRequired === step.redactionReviewRequired &&
      previousStep.devicePixelRatio === step.devicePixelRatio &&
      previousStep.screenshotScale === step.screenshotScale &&
      previousStep.description === step.description &&
      previousStep.url === step.url &&
      previousStep.timestamp === step.timestamp &&
      previousStep.groupId === step.groupId &&
      previousStep.numbered === step.numbered &&
      (previousStep.captureRevision ?? 0) === (step.captureRevision ?? 0) &&
      previousStep.lastCaptureRunId === step.lastCaptureRunId &&
      Boolean(previousStep.screenshotBlob) === Boolean(step.screenshotBlob);
    if (metadataMatch) return previousStep;
    if (!step.screenshotBlob || !previousStep.screenshotBlob) return step;
    if ((previousStep.captureRevision ?? 0) !== (step.captureRevision ?? 0)) return step;
    return { ...step, screenshotBlob: previousStep.screenshotBlob };
  });
  return reconciled.length === previous.length && reconciled.every((step, index) => step === previous[index])
    ? previous
    : reconciled;
}

/** Shared popup/editor state: current recording status, steps, and any error.
 * Omitting explicitSessionId follows the active recording (popup behavior).
 * Passing a string pins the data source to that Guide; passing null explicitly
 * means the editor URL has no Guide and must not fall back to unrelated global state. */
export function useRecordingSession(explicitSessionId?: string | null) {
  const [recordingState, setRecordingState] = useState(createDefaultRecordingState);
  const [steps, setSteps] = useState<Step[]>([]);
  const [dataError, setDataError] = useState<string | null>(null);
  const latestStepsRequest = useRef(0);
  const stepsRefreshInFlight = useRef<Promise<void> | null>(null);
  const mounted = useRef(true);
  const hasExplicitSession = explicitSessionId !== undefined;
  const explicitGuideSessionId =
    typeof explicitSessionId === 'string' && explicitSessionId.length > 0
      ? explicitSessionId
      : null;
  const explicitSessionIdRef = useRef(explicitGuideSessionId);
  const hasExplicitSessionRef = useRef(hasExplicitSession);
  explicitSessionIdRef.current = explicitGuideSessionId;
  hasExplicitSessionRef.current = hasExplicitSession;
  const sessionId = hasExplicitSession ? explicitGuideSessionId : recordingState.sessionId;

  const refreshSteps = useCallback((sid: string | null): Promise<void> => {
    const request = ++latestStepsRequest.current;
    let operation!: Promise<void>;
    operation = (async () => {
      try {
        const nextSteps = sid ? await getSteps(sid) : [];
        if (mounted.current && request === latestStepsRequest.current) {
          setSteps((previous) => reconcileSteps(previous, nextSteps));
          setDataError(null);
        }
      } catch (error) {
        if (mounted.current && request === latestStepsRequest.current) {
          setDataError('無法讀取錄製內容，請重新整理後再試一次。');
        }
        throw error;
      } finally {
        if (stepsRefreshInFlight.current === operation) stepsRefreshInFlight.current = null;
      }
    })();
    stepsRefreshInFlight.current = operation;
    return operation;
  }, []);

  const refreshStepsSafely = useCallback(async (sid: string | null) => {
    try {
      await refreshSteps(sid);
    } catch (error) {
      console.error('[frametrail] failed to refresh recording steps', error);
    }
  }, [refreshSteps]);

  useEffect(() => {
    mounted.current = true;
    let disposed = false;
    let stateVersion = 0;

    const applyState = (state: Awaited<ReturnType<typeof getRecordingState>>) => {
      if (disposed) return;
      setRecordingState(state);
      // A same-session state change can signal an IndexedDB write (notably a
      // completed recapture), so refresh even when the data-source id itself
      // did not change. An explicit editor URL still wins over that state.
      void refreshStepsSafely(
        hasExplicitSessionRef.current ? explicitSessionIdRef.current : state.sessionId,
      );
    };

    const initialVersion = stateVersion;
    void getRecordingState()
      .then((state) => {
        // A storage change can arrive while the initial read is pending. Its
        // newer state wins even if the older read resolves last.
        if (stateVersion === initialVersion) applyState(state);
      })
      .catch((error) => {
        if (disposed) return;
        console.error('[frametrail] failed to read recording state', error);
        setDataError('無法讀取錄製狀態，請重新整理後再試一次。');
      });

    const unsubscribe = onRecordingStateChange((state) => {
      stateVersion++;
      applyState(state);
    });

    return () => {
      disposed = true;
      mounted.current = false;
      latestStepsRequest.current++;
      unsubscribe();
    };
  }, [refreshStepsSafely]);

  // The editor may supply its URL session as the authoritative data source.
  // Keeping this separate from RecordingState lets an editor continue showing
  // Guide A while a global operation belongs to Guide B.
  useEffect(() => {
    void refreshStepsSafely(sessionId);
  }, [refreshStepsSafely, sessionId]);

  // Background writes new steps to IndexedDB independently of the UI;
  // poll while recording so the list updates without a custom pub/sub channel.
  useEffect(() => {
    if (
      !recordingState.isRecording ||
      !sessionId ||
      recordingState.sessionId !== sessionId
    ) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const poll = async () => {
      const activeRefresh = stepsRefreshInFlight.current;
      if (activeRefresh) {
        try {
          await activeRefresh;
        } catch {
          // The owner of the active refresh already records and logs failure.
        }
      } else {
        await refreshStepsSafely(sessionId);
      }
      if (!disposed) timer = setTimeout(() => void poll(), 1000);
    };
    timer = setTimeout(() => void poll(), 1000);
    return () => {
      disposed = true;
      if (timer) clearTimeout(timer);
    };
  }, [recordingState.isRecording, recordingState.sessionId, refreshStepsSafely, sessionId]);

  return {
    ...recordingState,
    sessionId,
    recording: recordingState,
    steps,
    dataError,
    refresh: () => refreshSteps(sessionId),
  };
}
