import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  compositeHighlight: vi.fn(),
  compositeMultiHighlight: vi.fn(),
}));

vi.mock('@/lib/media/annotate', () => ({
  compositeHighlight: mocks.compositeHighlight,
  compositeMultiHighlight: mocks.compositeMultiHighlight,
}));

import { compositeStepEntry } from '@/lib/export/entry-render';
import type { Step, StepEntry } from '@/lib/storage/db';

function makeStep(id: string, order: number, changes: Partial<Step> = {}): Step {
  return {
    id,
    sessionId: 'session',
    order,
    screenshotBlob: new Blob([id], { type: 'image/jpeg' }),
    bounds: { x: 10, y: 20, width: 30, height: 40 },
    devicePixelRatio: 1,
    description: '',
    url: 'https://example.com',
    timestamp: order,
    ...changes,
  };
}

beforeEach(() => {
  mocks.compositeHighlight.mockReset().mockResolvedValue(new Blob(['single'], { type: 'image/png' }));
  mocks.compositeMultiHighlight.mockReset().mockResolvedValue(new Blob(['group'], { type: 'image/jpeg' }));
});

describe('compositeStepEntry', () => {
  it('uses a single entry’s effective manual bounds and owned redactions', async () => {
    const step = makeStep('single', 1, {
      manualBounds: { x: 50, y: 60, width: 70, height: 80 },
      screenshotScale: 2,
      redactions: [{ id: 'mask', kind: 'solid', bounds: { x: 1, y: 2, width: 3, height: 4 } }],
    });
    const entry: StepEntry = { kind: 'single', step: step as Step & { screenshotBlob: Blob } };

    await compositeStepEntry(entry, 'image/png');

    expect(mocks.compositeHighlight).toHaveBeenCalledWith(
      step.screenshotBlob,
      step.manualBounds,
      2,
      'image/png',
      step.redactions,
      false,
    );
    expect(mocks.compositeMultiHighlight).not.toHaveBeenCalled();
  });

  it('uses the group anchor screenshot and masks while retaining all effective annotations', async () => {
    const anchor = makeStep('anchor', 1, {
      groupId: 'anchor',
      bounds: null,
      screenshotScale: 1.5,
      numbered: true,
      redactions: [{ id: 'mask', kind: 'solid', bounds: { x: 80, y: 90, width: 10, height: 20 } }],
    });
    const automatic = makeStep('automatic', 2, { groupId: 'anchor', screenshotBlob: undefined });
    const manual = makeStep('manual', 3, {
      groupId: 'anchor',
      screenshotBlob: undefined,
      manualBounds: { x: 100, y: 110, width: 12, height: 13 },
    });
    const entry: StepEntry = {
      kind: 'group',
      anchor: anchor as Step & { screenshotBlob: Blob },
      annotations: [automatic, manual],
    };

    await compositeStepEntry(entry, 'image/jpeg');

    expect(mocks.compositeMultiHighlight).toHaveBeenCalledWith(
      anchor.screenshotBlob,
      [
        { bounds: automatic.bounds, order: 1 },
        { bounds: manual.manualBounds, order: 2 },
      ],
      1.5,
      true,
      'image/jpeg',
      anchor.redactions,
      false,
    );
    expect(mocks.compositeHighlight).not.toHaveBeenCalled();
  });

  it('propagates privacy review as a full-image fail-closed render request', async () => {
    const step = makeStep('review', 1, {
      redactions: [{ id: 'mask', kind: 'solid', bounds: { x: 1, y: 2, width: 3, height: 4 } }],
      redactionReviewRequired: true,
    });
    const entry: StepEntry = { kind: 'single', step: step as Step & { screenshotBlob: Blob } };

    await compositeStepEntry(entry, 'image/png');

    expect(mocks.compositeHighlight).toHaveBeenCalledWith(
      step.screenshotBlob,
      step.bounds,
      1,
      'image/png',
      step.redactions,
      true,
    );
  });

});
