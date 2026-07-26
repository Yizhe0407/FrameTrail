import type { StepRecaptureTarget } from '../runtime/messages';
import type { Step, StepEntry } from '../storage/models';

export const EMPTY_STEP_ENTRIES: StepEntry[] = [];

export interface UndoAction {
  id: number;
  message: string;
  guideId: string;
  expectedRevision: number;
  restoreSelectionId?: string;
  restore: () => Promise<void>;
}

/** What a mutation describes about its own undo. The editor controller owns the
 * sequence number and the guide it belongs to, so a mutation never supplies
 * either. */
export type PendingUndoAction = Omit<UndoAction, 'id' | 'guideId'>;

export type PreparedCapturePermission = {
  sourceOrigin: string;
  permissionPattern: string;
  /** The entry the grant is bound to, so changing the selection cancels it.
   * Continuation records into the Guide as a whole and has no such anchor. */
  entryId: string | null;
  action:
    | { kind: 'recapture'; target: StepRecaptureTarget }
    | { kind: 'continuation' };
};

export function entrySteps(entry: StepEntry): Step[] {
  return entry.kind === 'single' ? [entry.step] : [entry.anchor, ...entry.annotations];
}

export function equalIds(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

