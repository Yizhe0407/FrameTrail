import { useCallback, useEffect, useState } from 'react';
import { getProject } from '../storage/project-repository';
import { getProjectStructureSnapshot, type ProjectStructureSnapshot } from '../storage/project-structure';
import { type Project } from '../storage/models';
import { retainScreenshotBlobs } from './retain-screenshot-blobs';

export type EditorProjectLoadState = 'loading' | 'ready' | 'missing' | 'invalid';

/**
 * Owns the canonical Project/entry snapshot load and its fail-closed state:
 * the mount-time load, explicit reloads, and the shared fallback that
 * downgrades to 'invalid'/'missing' when the structure cannot be read all
 * live here once. Mutations remain in the editor controller, which publishes
 * their results through `reload`/`adoptProject` instead of raw setters.
 */
export function useEditorProjectData(sessionId: string | null, steps: readonly unknown[]) {
  const [project, setProject] = useState<Project | null>(null);
  const [canonicalSnapshot, setCanonicalSnapshot] = useState<ProjectStructureSnapshot | null>(null);
  const [projectLoadState, setProjectLoadState] = useState<EditorProjectLoadState>(
    sessionId ? 'loading' : 'missing',
  );

  /** Publishes a freshly read canonical snapshot as the current editor data. */
  const adoptSnapshot = useCallback((snapshot: ProjectStructureSnapshot) => {
    setProject(snapshot.project);
    // Unchanged screenshots keep their Blob identity so reloading after an edit doesn't reload every image.
    setCanonicalSnapshot((current) => ({
      ...snapshot,
      entries: retainScreenshotBlobs(current?.entries ?? [], snapshot.entries),
    }));
    setProjectLoadState('ready');
  }, []);

  /** Publishes the fresh Project a successful compare-and-swap returned. The
   * entry list stays canonical until the caller's follow-up `reload`. */
  const adoptProject = useCallback((nextProject: Project | null) => {
    setProject(nextProject);
  }, []);

  /** Falls back after a failed structure read: keep the bare Project when it
   * still exists ('invalid') and report 'missing' otherwise. */
  const applyLoadFailure = useCallback(async (
    failedSessionId: string,
    isCancelled: () => boolean = () => false,
  ) => {
    const existingProject = await getProject(failedSessionId).catch(() => undefined);
    if (isCancelled()) return;
    setProject(existingProject ?? null);
    setCanonicalSnapshot(null);
    setProjectLoadState(existingProject ? 'invalid' : 'missing');
  }, []);

  const clear = useCallback(() => {
    setProject(null);
    setCanonicalSnapshot(null);
    setProjectLoadState('missing');
  }, []);

  /** Re-reads and adopts the canonical snapshot, returning it so callers that
   * need the fresh structure (e.g. publication) never re-implement the
   * read-then-adopt pair. Unlike the mount-time load it rethrows the
   * structure-read failure (after downgrading the state) so callers can
   * report the reload that went wrong. */
  const reload = useCallback(async (): Promise<ProjectStructureSnapshot | null> => {
    if (!sessionId) {
      clear();
      return null;
    }
    try {
      const snapshot = await getProjectStructureSnapshot(sessionId);
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
    setProjectLoadState((current) => current === 'ready' ? current : 'loading');
    void getProjectStructureSnapshot(sessionId).then((snapshot) => {
      if (disposed) return;
      adoptSnapshot(snapshot);
    }).catch(async (loadError) => {
      console.error('[stepmark] failed to read the project structure', loadError);
      if (disposed) return;
      await applyLoadFailure(sessionId, () => disposed);
    });
    return () => { disposed = true; };
  }, [adoptSnapshot, applyLoadFailure, clear, sessionId, steps]);

  return {
    project,
    canonicalSnapshot,
    projectLoadState,
    reload,
    adoptProject,
  };
}
