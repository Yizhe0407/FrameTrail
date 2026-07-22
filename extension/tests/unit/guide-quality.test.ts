import 'fake-indexeddb/auto';
import { describe, expect, it, vi } from 'vitest';
import {
  analyzeGuideQuality,
  createGuideEntryIndex,
  filterGuideEntries,
  filterGuideEntryIndex,
  getEntrySearchText,
  matchesEntryText,
} from '@/lib/guide-quality';
import type { Step, StepEntry } from '@/lib/db';

function makeStep(id: string, description: string, changes: Partial<Step> = {}): Step {
  return {
    id,
    sessionId: 'guide-1',
    order: 0,
    screenshotBlob: new Blob(['image'], { type: 'image/png' }),
    bounds: { x: 10, y: 20, width: 30, height: 40 },
    devicePixelRatio: 1,
    description,
    url: `https://example.com/${id}`,
    timestamp: 1,
    ...changes,
  };
}

function single(id: string, description: string, changes: Partial<Step> = {}): StepEntry {
  const step = makeStep(id, description, changes);
  return { kind: 'single', step: step as Step & { screenshotBlob: Blob } };
}

function group(id: string, descriptions: readonly string[], changes: Partial<Step> = {}): StepEntry {
  const anchor = makeStep(id, '', { groupId: id, bounds: null, ...changes });
  return {
    kind: 'group',
    anchor: anchor as Step & { screenshotBlob: Blob },
    annotations: descriptions.map((description, index) => makeStep(`${id}-annotation-${index}`, description, {
      order: index + 1,
      groupId: id,
      screenshotBlob: undefined,
    })),
  };
}

describe('analyzeGuideQuality', () => {
  it('finds description, privacy, image, and bounds issues without reading image bytes', () => {
    const missingImage = new Blob([], { type: 'image/png' });
    const arrayBuffer = vi.spyOn(missingImage, 'arrayBuffer');
    const entries = [
      single('empty', '   ', {
        screenshotBlob: missingImage,
        bounds: null,
        redactionReviewRequired: true,
      }),
      single('duplicate-a', '  Open   Settings  '),
      group('snapshot', ['open settings', '', 'Unique annotation'], {
        redactions: [{ id: 'mask', kind: 'solid', bounds: { x: 1, y: 2, width: 3, height: 4 } }],
      }),
    ];

    const report = analyzeGuideQuality(entries);

    expect(arrayBuffer).not.toHaveBeenCalled();
    expect(report.entryCount).toBe(3);
    expect(report.descriptionCount).toBe(5);
    expect(report.affectedEntryCount).toBe(3);
    expect(report.entries[0].issues).toEqual([
      'empty-description',
      'redaction-review-required',
      'missing-image',
      'missing-bounds',
    ]);
    expect(report.entries[1].issues).toEqual(['duplicate-description']);
    expect(report.entries[2].issues).toEqual(['empty-description', 'duplicate-description']);
    expect(report.issueCounts['duplicate-description']).toBe(2);
    expect(report.occurrenceCounts['empty-description']).toBe(2);
  });

  it('counts repeated descriptions and invalid bounds within one snapshot', () => {
    const entry = group('snapshot', ['Repeat me', ' repeat   me ', ''], {});
    if (entry.kind !== 'group') throw new Error('expected a snapshot entry');
    entry.annotations[1].bounds = null;

    const report = analyzeGuideQuality([entry]);

    expect(report.entries[0].issues).toEqual([
      'empty-description',
      'duplicate-description',
      'missing-bounds',
    ]);
    expect(report.entries[0].occurrences).toMatchObject({
      'empty-description': 1,
      'duplicate-description': 2,
      'missing-bounds': 1,
    });
  });

  it('flags a configurable very-long guide at the threshold', () => {
    const report = analyzeGuideQuality(
      [single('one', 'One'), single('two', 'Two'), single('three', 'Three')],
      { veryLongThreshold: 3 },
    );

    expect(report.isVeryLong).toBe(true);
    expect(report.issueCounts['very-long-guide']).toBe(1);
    expect(report.totalIssueCount).toBe(1);
  });
});

describe('guide entry search and filters', () => {
  const entries = [
    single('account', 'Open account settings'),
    group('billing', ['Choose Billing', 'Confirm invoice']),
    single('broken', '', { bounds: null }),
  ];
  const report = analyzeGuideQuality(entries);
  const index = createGuideEntryIndex(entries, report);

  it('builds searchable text from descriptions, ids, and URLs', () => {
    expect(getEntrySearchText(entries[1])).toContain('confirm invoice');
    expect(getEntrySearchText(entries[0])).toContain('example.com/account');
    expect(matchesEntryText(index[1].searchText, 'billing invoice')).toBe(true);
    expect(matchesEntryText(index[1].searchText, 'invoice missing')).toBe(false);
  });

  it('combines kind, issue, and text filters in one linear pass', () => {
    expect(filterGuideEntryIndex(index, { kind: 'group', text: 'billing' }).map((item) => item.entryId))
      .toEqual(['billing']);
    expect(filterGuideEntryIndex(index, { issue: 'any' }).map((item) => item.entryId))
      .toEqual(['broken']);
    expect(filterGuideEntryIndex(index, { issue: 'none', text: 'settings' }).map((item) => item.entryId))
      .toEqual(['account']);
    expect(filterGuideEntryIndex(index, {
      issues: ['empty-description', 'missing-bounds'],
      issueMatch: 'all',
    }).map((item) => item.entryId)).toEqual(['broken']);
  });

  it('offers a convenience helper that returns original entry identities', () => {
    expect(filterGuideEntries(entries, { text: 'confirm' }, report)).toEqual([entries[1]]);
  });
});
