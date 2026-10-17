import { useCallback, useEffect, useRef, useState } from 'react';
import toast from 'react-hot-toast';
import type { PendingUndoAction, UndoAction } from '@/lib/editor/editor-app-model';
import { type Project } from '@/lib/storage/models';
import { t } from '@/lib/shared/i18n';

/**
 * Bookkeeping for the editor's single offered undo action. An undo is only valid against the exact
 * revision its mutation produced, so it ends as soon as the Project moves on — and the user is told
 * whenever one ends before its own window does: either on the snackbar of the undo that replaced it
 * (`supersedes`), or with a toast when nothing replaced it.
 */
export function useProjectUndo({ project, operationActive, projectDeleted = false }: {
  project: Project | null;
  operationActive: boolean;
  /** A deleted Project has nothing left to undo into; its undo ends silently. */
  projectDeleted?: boolean;
}) {
  const [undoAction, setUndoAction] = useState<UndoAction | null>(null);
  // The ref is the source of truth so a mutation can take the pending undo synchronously.
  const current = useRef<UndoAction | null>(null);
  const latestProject = useRef(project);
  const undoSequence = useRef(0);

  const publish = useCallback((next: UndoAction | null) => {
    current.current = next;
    setUndoAction(next);
  }, []);

  /** Why `action` can no longer be offered, if it can't: 'gone' when its Project is. */
  const invalidity = useCallback((action: UndoAction): 'gone' | 'moved' | null => {
    const latest = latestProject.current;
    if (!latest || projectDeleted || action.projectId !== latest.id) return 'gone';
    if (operationActive || action.expectedRevision !== latest.contentRevision) return 'moved';
    return null;
  }, [operationActive, projectDeleted]);

  useEffect(() => {
    latestProject.current = project;
    const pending = current.current;
    if (!pending) return;
    const reason = invalidity(pending);
    if (!reason) return;
    publish(null);
    if (reason === 'moved') toast(t().editor.undo.nowFinal(pending.message));
  }, [project, invalidity, publish]);

  /** Offers a new undo. `superseded` is the earlier undo this mutation took (see `takeUndo`),
   * which is now final; the new snackbar says so. */
  const offerUndo = useCallback((pending: PendingUndoAction, projectId: string, superseded?: UndoAction | null) => {
    publish({
      ...pending,
      id: ++undoSequence.current,
      projectId,
      ...(superseded ? { supersedes: superseded.message } : {}),
    });
  }, [publish]);

  /** Takes the pending undo off screen while another mutation runs. The caller hands it back
   * through `offerUndo` (as `superseded`), `returnUndo` (the mutation failed) or `finalizeUndo`. */
  const takeUndo = useCallback((): UndoAction | null => {
    const taken = current.current;
    publish(null);
    return taken;
  }, [publish]);

  /** Puts a taken undo back after a mutation that changed nothing, if it is still valid. */
  const returnUndo = useCallback((taken: UndoAction | null) => {
    if (!taken || current.current) return;
    const reason = invalidity(taken);
    if (!reason) publish(taken);
    else if (reason === 'moved') toast(t().editor.undo.nowFinal(taken.message));
  }, [invalidity, publish]);

  /** Tells the user a taken undo became final without a new undo to say it on. */
  const finalizeUndo = useCallback((taken: UndoAction | null) => {
    if (taken) toast(t().editor.undo.nowFinal(taken.message));
  }, []);

  const clearUndo = useCallback(() => publish(null), [publish]);

  return { undoAction, offerUndo, takeUndo, returnUndo, finalizeUndo, clearUndo };
}
