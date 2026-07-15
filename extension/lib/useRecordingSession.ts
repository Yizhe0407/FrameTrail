import { useCallback, useEffect, useState } from 'react';
import { getRecordingState, onRecordingStateChange } from './storage';
import { getSteps, type Step } from './db';

/** Shared popup/editor state: current recording status, steps, and any error. */
export function useRecordingSession() {
  const [isRecording, setIsRecording] = useState(false);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [steps, setSteps] = useState<Step[]>([]);
  const [error, setError] = useState<string | null>(null);

  const refreshSteps = useCallback(async (sid: string | null) => {
    setSteps(sid ? await getSteps(sid) : []);
  }, []);

  useEffect(() => {
    getRecordingState().then((state) => {
      setIsRecording(state.isRecording);
      setSessionId(state.sessionId);
      setError(state.error);
      refreshSteps(state.sessionId);
    });
    return onRecordingStateChange((state) => {
      setIsRecording(state.isRecording);
      setSessionId(state.sessionId);
      setError(state.error);
      refreshSteps(state.sessionId);
    });
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
