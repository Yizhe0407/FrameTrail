import { useEffect, useState } from 'react';
import {
  getGuide,
  getGuideStructureSnapshot,
  type Guide,
  type GuideStructureSnapshot,
} from '../storage/db';

export type EditorGuideLoadState = 'loading' | 'ready' | 'missing' | 'invalid';

/** Owns the canonical Guide/entry snapshot load and its fail-closed state.
 * Mutations remain in the editor controller, which receives the setters so a
 * successful CAS can publish its fresh Guide without a second abstraction. */
export function useEditorGuideData(sessionId: string | null, steps: readonly unknown[]) {
  const [guide, setGuide] = useState<Guide | null>(null);
  const [canonicalSnapshot, setCanonicalSnapshot] = useState<GuideStructureSnapshot | null>(null);
  const [guideLoadState, setGuideLoadState] = useState<EditorGuideLoadState>(
    sessionId ? 'loading' : 'missing',
  );

  useEffect(() => {
    let disposed = false;
    if (!sessionId) {
      setGuide(null);
      setCanonicalSnapshot(null);
      setGuideLoadState('missing');
      return () => { disposed = true; };
    }
    setGuideLoadState((current) => current === 'ready' ? current : 'loading');
    void getGuideStructureSnapshot(sessionId).then((snapshot) => {
      if (disposed) return;
      setGuide(snapshot.guide);
      setCanonicalSnapshot(snapshot);
      setGuideLoadState('ready');
    }).catch(async (loadError) => {
      console.error('讀取 Guide 結構失敗', loadError);
      if (disposed) return;
      const existingGuide = await getGuide(sessionId).catch(() => undefined);
      if (disposed) return;
      setGuide(existingGuide ?? null);
      setCanonicalSnapshot(null);
      setGuideLoadState(existingGuide ? 'invalid' : 'missing');
    });
    return () => { disposed = true; };
  }, [sessionId, steps]);

  return {
    guide,
    setGuide,
    canonicalSnapshot,
    setCanonicalSnapshot,
    guideLoadState,
    setGuideLoadState,
  };
}
