import { useCallback, useEffect, useState } from 'react';
import { getGuide } from '../storage/guide-repository';
import { getGuideStructureSnapshot, type GuideStructureSnapshot } from '../storage/guide-structure';
import { type Guide } from '../storage/models';

export type EditorGuideLoadState = 'loading' | 'ready' | 'missing' | 'invalid';

/**
 * Owns the canonical Guide/entry snapshot load and its fail-closed state:
 * the mount-time load, explicit reloads, and the shared fallback that
 * downgrades to 'invalid'/'missing' when the structure cannot be read all
 * live here once. Mutations remain in the editor controller, which publishes
 * their results through `reload`/`adoptGuide` instead of raw setters.
 */
export function useEditorGuideData(sessionId: string | null, steps: readonly unknown[]) {
  const [guide, setGuide] = useState<Guide | null>(null);
  const [canonicalSnapshot, setCanonicalSnapshot] = useState<GuideStructureSnapshot | null>(null);
  const [guideLoadState, setGuideLoadState] = useState<EditorGuideLoadState>(
    sessionId ? 'loading' : 'missing',
  );

  /** Publishes a freshly read canonical snapshot as the current editor data. */
  const adoptSnapshot = useCallback((snapshot: GuideStructureSnapshot) => {
    setGuide(snapshot.guide);
    setCanonicalSnapshot(snapshot);
    setGuideLoadState('ready');
  }, []);

  /** Publishes the fresh Guide a successful compare-and-swap returned. The
   * entry list stays canonical until the caller's follow-up `reload`. */
  const adoptGuide = useCallback((nextGuide: Guide | null) => {
    setGuide(nextGuide);
  }, []);

  /** Falls back after a failed structure read: keep the bare Guide when it
   * still exists ('invalid') and report 'missing' otherwise. */
  const applyLoadFailure = useCallback(async (
    failedSessionId: string,
    isCancelled: () => boolean = () => false,
  ) => {
    const existingGuide = await getGuide(failedSessionId).catch(() => undefined);
    if (isCancelled()) return;
    setGuide(existingGuide ?? null);
    setCanonicalSnapshot(null);
    setGuideLoadState(existingGuide ? 'invalid' : 'missing');
  }, []);

  const clear = useCallback(() => {
    setGuide(null);
    setCanonicalSnapshot(null);
    setGuideLoadState('missing');
  }, []);

  /** Re-reads and adopts the canonical snapshot, returning it so callers that
   * need the fresh structure (e.g. publication) never re-implement the
   * read-then-adopt pair. Unlike the mount-time load it rethrows the
   * structure-read failure (after downgrading the state) so callers can
   * report the reload that went wrong. */
  const reload = useCallback(async (): Promise<GuideStructureSnapshot | null> => {
    if (!sessionId) {
      clear();
      return null;
    }
    try {
      const snapshot = await getGuideStructureSnapshot(sessionId);
      adoptSnapshot(snapshot);
      return snapshot;
    } catch (reloadError) {
      await applyLoadFailure(sessionId);
      throw reloadError;
    }
  }, [adoptSnapshot, applyLoadFailure, clear, sessionId]);

  useEffect(() => {
    let disposed = false;
    if (!sessionId) {
      clear();
      return () => { disposed = true; };
    }
    setGuideLoadState((current) => current === 'ready' ? current : 'loading');
    void getGuideStructureSnapshot(sessionId).then((snapshot) => {
      if (disposed) return;
      adoptSnapshot(snapshot);
    }).catch(async (loadError) => {
      console.error('讀取 Guide 結構失敗', loadError);
      if (disposed) return;
      await applyLoadFailure(sessionId, () => disposed);
    });
    return () => { disposed = true; };
  }, [adoptSnapshot, applyLoadFailure, clear, sessionId, steps]);

  return {
    guide,
    canonicalSnapshot,
    guideLoadState,
    reload,
    adoptGuide,
  };
}
