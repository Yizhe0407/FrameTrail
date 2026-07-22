import { describe, expect, it } from 'vitest';

import type { Step, StepEntry } from '@/lib/db';
import {
  GUIDE_SECTION_LIMITS,
  repairGuideSections,
  sanitizeGuideSectionTitle,
} from '@/lib/guide-sections';

function step(id: string, order: number, overrides: Partial<Step> = {}): Step {
  return {
    id,
    sessionId: 'guide-1',
    order,
    screenshotBlob: new Blob([id], { type: 'image/png' }),
    bounds: { x: 0, y: 0, width: 10, height: 10 },
    devicePixelRatio: 1,
    description: id,
    url: 'https://example.com/',
    timestamp: order,
    ...overrides,
  };
}

function entries(): StepEntry[] {
  const anchor = step('snapshot', 1, { bounds: null, groupId: 'snapshot' });
  const annotation = step('annotation', 2, {
    screenshotBlob: undefined,
    groupId: 'snapshot',
  });
  return [
    { kind: 'single', step: step('first', 0) as Step & { screenshotBlob: Blob } },
    {
      kind: 'group',
      anchor: anchor as Step & { screenshotBlob: Blob },
      annotations: [annotation],
    },
    { kind: 'single', step: step('last', 3) as Step & { screenshotBlob: Blob } },
  ];
}

describe('guide sections', () => {
  it('sanitizes titles as bounded single-line display text', () => {
    expect(sanitizeGuideSectionTitle('\u0000  First\n\tchapter\u007f  ')).toBe('Firstchapter');
    expect(sanitizeGuideSectionTitle('x'.repeat(GUIDE_SECTION_LIMITS.maxTitleLength + 20))).toHaveLength(
      GUIDE_SECTION_LIMITS.maxTitleLength,
    );
    expect(sanitizeGuideSectionTitle(null)).toBe('');
  });

  it('keeps only complete entry boundaries and sorts by timeline order', () => {
    expect(repairGuideSections([
      { id: 'last-section', title: ' Last ', startEntryId: 'last' },
      { id: 'annotation-section', title: 'Unsafe middle', startEntryId: 'annotation' },
      { id: 'first-section', title: 'First', startEntryId: 'first' },
      { id: 'snapshot-section', title: 'Snapshot', startEntryId: 'snapshot' },
    ], entries())).toEqual([
      { id: 'first-section', title: 'First', startEntryId: 'first' },
      { id: 'snapshot-section', title: 'Snapshot', startEntryId: 'snapshot' },
      { id: 'last-section', title: 'Last', startEntryId: 'last' },
    ]);
  });

  it('drops malformed and later duplicate ids or starts deterministically', () => {
    expect(repairGuideSections([
      { id: 'same', title: 'First winner', startEntryId: 'first' },
      { id: 'same', title: 'Duplicate id', startEntryId: 'snapshot' },
      { id: 'different', title: 'Duplicate start', startEntryId: 'first' },
      { id: '', title: 'Empty id', startEntryId: 'last' },
      { id: 'empty-title', title: '\n\u0000', startEntryId: 'last' },
      { id: ' padded ', title: 'Bad id', startEntryId: 'last' },
      {
        id: 'x'.repeat(GUIDE_SECTION_LIMITS.maxIdLength + 1),
        title: 'Overlong id',
        startEntryId: 'last',
      },
      {
        id: 'overlong-start',
        title: 'Overlong start',
        startEntryId: 'x'.repeat(GUIDE_SECTION_LIMITS.maxIdLength + 1),
      },
    ], entries())).toEqual([
      { id: 'same', title: 'First winner', startEntryId: 'first' },
    ]);
  });

  it('caps repair work and output count', () => {
    const manyEntries = Array.from({ length: GUIDE_SECTION_LIMITS.maxSections + 10 }, (_, index) => ({
      kind: 'single' as const,
      step: step(`step-${index}`, index) as Step & { screenshotBlob: Blob },
    }));
    const sections = manyEntries.map((_, index) => ({
      id: `section-${index}`,
      title: `Section ${index}`,
      startEntryId: `step-${index}`,
    }));

    expect(repairGuideSections(sections, manyEntries)).toHaveLength(GUIDE_SECTION_LIMITS.maxSections);
  });
});
