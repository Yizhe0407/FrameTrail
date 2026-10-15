import { updateStepsAtomically } from '../storage/step-repository';
import { getEntryImageOwner, type Redaction, type StepEntry } from '../storage/models';

/** Saves an entry's masks on the step that owns the image (the step itself, or
 * a snapshot's shared anchor). Guarded by the image's capture revision: if the
 * image was retaken since the editor loaded it, the write is refused rather
 * than placing masks over a different picture. */
export async function saveEntryRedactions(entry: StepEntry, redactions: Redaction[]): Promise<void> {
  const owner = getEntryImageOwner(entry);
  await updateStepsAtomically(owner.sessionId, [{
    id: owner.id,
    changes: { redactions },
    expectedCaptureRevision: owner.captureRevision ?? 0,
  }]);
}
