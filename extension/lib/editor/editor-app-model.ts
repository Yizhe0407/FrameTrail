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

export type PreparedCapturePermission = {
  sourceOrigin: string;
  permissionPattern: string;
  entryId: string;
  action: {
    kind: 'recapture';
    target: StepRecaptureTarget;
  };
};

export function entrySteps(entry: StepEntry): Step[] {
  return entry.kind === 'single' ? [entry.step] : [entry.anchor, ...entry.annotations];
}

export function equalIds(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

function visualValueEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  return JSON.stringify(left) === JSON.stringify(right);
}

export function stepMatchesVisualBaseline(step: Step, changes: Partial<Step>): boolean {
  return Object.entries(changes).every(([key, expected]) => (
    visualValueEqual(step[key as keyof Step], expected)
  ));
}
