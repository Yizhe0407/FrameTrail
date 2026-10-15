import { useCallback, useEffect, useRef, useState } from 'react';
import type { PendingUndoAction, UndoAction } from '@/lib/editor/editor-app-model';
import { type Project } from '@/lib/storage/models';

/**
 * Bookkeeping for the editor's single offered undo action. An undo is only valid against the exact
 * revision its mutation produced, so it's dropped as soon as the Project moves on.
 */
export function useProjectUndo({ project, operationActive }: {
  project: Project | null;
  operationActive: boolean;
}) {
  const [undoAction, setUndoAction] = useState<UndoAction | null>(null);
  const undoSequence = useRef(0);

  useEffect(() => {
    setUndoAction((current) => {
      if (!current) return null;
      if (
        operationActive ||
        !project ||
        current.projectId !== project.id ||
        current.expectedRevision !== project.contentRevision
      ) {
        return null;
      }
      return current;
    });
  }, [project, operationActive]);

  const offerUndo = useCallback((pending: PendingUndoAction, projectId: string) => {
    setUndoAction({ ...pending, id: ++undoSequence.current, projectId });
  }, []);

  const clearUndo = useCallback(() => setUndoAction(null), []);

  return { undoAction, offerUndo, clearUndo };
}
