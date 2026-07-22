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
  const latestStepsRequest = useRef(0);
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
      setRecordingState(state);
      // A same-session state change can signal an IndexedDB write (notably a
      // completed recapture), so refresh even when the data-source id itself
      // did not change. An explicit editor URL still wins over that state.
      void refreshSteps(
        hasExplicitSessionRef.current ? explicitSessionIdRef.current : state.sessionId,
      );
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
  }, []);

  // The editor may supply its URL session as the authoritative data source.
  // Keeping this separate from RecordingState lets an editor continue showing
  // Guide A while a global operation belongs to Guide B.
  useEffect(() => {
    void refreshSteps(sessionId);
  }, [refreshSteps, sessionId]);

  // Background writes new steps to IndexedDB independently of the UI;
  // poll while recording so the list updates without a custom pub/sub channel.
  useEffect(() => {
    if (
      !recordingState.isRecording ||
      !sessionId ||
      recordingState.sessionId !== sessionId
    ) return;
    const interval = setInterval(() => refreshSteps(sessionId), 1000);
    return () => clearInterval(interval);
  }, [recordingState.isRecording, recordingState.sessionId, refreshSteps, sessionId]);

  return {
    ...recordingState,
    sessionId,
    recording: recordingState,
    steps,
    refresh: () => refreshSteps(sessionId),
  };
}
