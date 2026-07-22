import { describe, expect, it, vi } from 'vitest';
import type { Step, StepEntry } from '@/lib/db';
import {
  assertPublicationReady,
  evaluatePublicationReadiness,
  PublicationBlockedError,
} from '@/lib/publication-policy';

function entry(id: string, changes: Partial<Step> = {}): StepEntry {
  const step: Step = {
    id,
    sessionId: 'guide',
    order: 0,
    screenshotBlob: new Blob(['image'], { type: 'image/png' }),
    bounds: { x: 1, y: 2, width: 3, height: 4 },
    devicePixelRatio: 1,
    description: `步驟 ${id}`,
    url: 'https://example.com/',
    timestamp: 1,
    ...changes,
  };
  return { kind: 'single', step: step as Step & { screenshotBlob: Blob } };
}

describe('publication policy', () => {
  it('遮罩待確認、缺圖與缺框會 fail closed，且不讀取圖片內容', () => {
    const image = new Blob(['private'], { type: 'image/png' });
    const read = vi.spyOn(image, 'arrayBuffer');
    const entries = [
      entry('privacy', { screenshotBlob: image, redactionReviewRequired: true }),
      entry('image', { screenshotBlob: new Blob([], { type: 'image/png' }) }),
      entry('bounds', { bounds: null }),
    ];

    const readiness = evaluatePublicationReadiness(entries);

    expect(read).not.toHaveBeenCalled();
    expect(readiness.canPublish).toBe(false);
    expect(readiness.blockingCount).toBe(3);
    expect(readiness.blockingEntryIds).toEqual(['privacy', 'image', 'bounds']);
    expect(() => assertPublicationReady(entries)).toThrow(PublicationBlockedError);
  });

  it('空白與重複說明只顯示提醒，不阻止發佈', () => {
    const entries = [entry('one', { description: '' }), entry('two', { description: '重複' }), entry('three', { description: '  重複  ' })];

    const readiness = assertPublicationReady(entries);

    expect(readiness.canPublish).toBe(true);
    expect(readiness.blockingCount).toBe(0);
    expect(readiness.report.issueCounts['empty-description']).toBe(1);
    expect(readiness.report.issueCounts['duplicate-description']).toBe(2);
  });
});
