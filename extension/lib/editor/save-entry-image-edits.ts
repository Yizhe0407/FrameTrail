import { updateStepsAtomically } from '../storage/step-repository';
import { getEntryImageOwner, type StepEntry } from '../storage/models';
import type { SplitItems } from './image-edit-items';

/** Saves an entry's masks, drawn edits and crop on the step that owns the image (the
 * step itself, or a snapshot's shared anchor) in one write. Guarded by the
 * image's capture revision: if the image was retaken since the editor loaded
 * it, the write is refused rather than placing marks over a different picture. */
export async function saveEntryImageEdits(entry: StepEntry, { redactions, imageEdits, crop }: SplitItems): Promise<void> {
  const owner = getEntryImageOwner(entry);
  await updateStepsAtomically(owner.sessionId, [{
    id: owner.id,
    changes: { redactions, imageEdits, crop },
    expectedCaptureRevision: owner.captureRevision ?? 0,
  }]);
}
