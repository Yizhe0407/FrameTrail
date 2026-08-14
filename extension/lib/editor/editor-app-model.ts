import type { StepRecaptureTarget } from '../storage/recording-state';
import { type StepEntry } from '../storage/models';

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

export type PreparedCaptureSource =
  /** `sourceUrl` is the background-resolved persisted URL. The elsewhere tab
   * picker only compares it against candidate tab URLs (to skip preselecting
   * the page the user just recorded); it is never sent anywhere. */
  | { kind: 'origin'; sourceOrigin: string; permissionPattern: string; sourceUrl: string }
  /** The Guide has no recorded source page (no steps), so the confirmation
   * dialog can only offer the site-agnostic elsewhere continuation. Only a
   * continuation action may carry this: recapture always targets a stored
   * step and therefore always has an origin. */
  | { kind: 'unavailable'; reason: string };

/** One open, recordable tab offered by the 改在其他頁面接續 picker. */
export interface ContinuationTabOption {
  id: number;
  windowId: number;
  title: string;
  url: string;
  favIconUrl?: string;
}

export type PreparedCapturePermission = {
  source: PreparedCaptureSource;
  /** The entry the grant is bound to, so changing the selection cancels it.
   * Continuation records into the Guide as a whole and has no such anchor. */
  entryId: string | null;
  action:
    | { kind: 'recapture'; target: StepRecaptureTarget }
    | { kind: 'continuation' };
};

export function equalIds(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

