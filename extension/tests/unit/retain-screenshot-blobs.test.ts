import { describe, expect, it } from 'vitest';
import { retainScreenshotBlobs } from '@/lib/editor/retain-screenshot-blobs';
import type { ScreenshotStep, StepEntry } from '@/lib/storage/models';

function step(id: string, overrides: Partial<ScreenshotStep> = {}, content = 'pixels'): ScreenshotStep {
  return {
    id, sessionId: 's', order: 0, bounds: null, devicePixelRatio: 1, description: '', url: 'https://x.test', timestamp: 0,
    screenshotBlob: new Blob([content], { type: 'image/png' }), ...overrides,
  };
}

const single = (s: ScreenshotStep): StepEntry => ({ kind: 'single', step: s });

describe('retainScreenshotBlobs', () => {
  it('keeps the previous Blob for an unchanged image even though the reload produced a new object', () => {
    const before = [single(step('a'))];
    const after = [single(step('a', { description: 'edited' }))];

    const result = retainScreenshotBlobs(before, after);

    expect(result[0].kind === 'single' && result[0].step.screenshotBlob).toBe(before[0].kind === 'single' && before[0].step.screenshotBlob);
    expect(result[0].kind === 'single' && result[0].step.description).toBe('edited');
  });

  it('takes the new Blob when the image was recaptured', () => {
    const before = [single(step('a', { captureRevision: 0 }))];
    const after = [single(step('a', { captureRevision: 1 }, 'other pixels!'))];

    const result = retainScreenshotBlobs(before, after);

    expect(result[0].kind === 'single' && result[0].step.screenshotBlob).toBe(after[0].kind === 'single' && after[0].step.screenshotBlob);
  });

  it('retains a snapshot anchor image and ignores steps it has not seen before', () => {
    const anchorBefore = step('g', { groupId: 'g' });
    const before: StepEntry[] = [{ kind: 'group', anchor: anchorBefore, annotations: [] }];
    const after: StepEntry[] = [
      { kind: 'group', anchor: step('g', { groupId: 'g' }), annotations: [] },
      single(step('new')),
    ];

    const result = retainScreenshotBlobs(before, after);

    expect(result[0].kind === 'group' && result[0].anchor.screenshotBlob).toBe(anchorBefore.screenshotBlob);
    expect(result[1]).toBe(after[1]);
  });
});
