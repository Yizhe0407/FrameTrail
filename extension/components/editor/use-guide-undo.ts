import { useCallback, useEffect, useRef, useState } from 'react';
import type { PendingUndoAction, UndoAction } from '@/lib/editor/editor-app-model';
import { type Guide } from '@/lib/storage/models';

/**
 * Bookkeeping for the editor's single offered undo action.
 *
 * An undo is only valid against the exact revision its mutation produced, so
 * the action is dropped as soon as the Guide moves on (another edit, a
 * recording/recapture run, or a different Guide entirely).
 */
export function useGuideUndo({ guide, operationActive }: {
  guide: Guide | null;
  operationActive: boolean;
}) {
  const [undoAction, setUndoAction] = useState<UndoAction | null>(null);
  const undoSequence = useRef(0);

  useEffect(() => {
    setUndoAction((current) => {
      if (!current) return null;
      if (
        operationActive ||
        !guide ||
        current.guideId !== guide.id ||
        current.expectedRevision !== guide.contentRevision
      ) {
        return null;
      }
      return current;
    });
  }, [guide, operationActive]);

  const offerUndo = useCallback((pending: PendingUndoAction, guideId: string) => {
    setUndoAction({ ...pending, id: ++undoSequence.current, guideId });
  }, []);

  const clearUndo = useCallback(() => setUndoAction(null), []);

  return { undoAction, offerUndo, clearUndo };
}
