// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { useMemo, useState } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import GuideQualityDialog from '@/components/GuideQualityDialog';
import StepRailFilters, { type StepRailFilterValue } from '@/components/StepRailFilters';
import {
  analyzeGuideQuality,
  createGuideEntryIndex,
  filterGuideEntryIndex,
} from '@/lib/guide-quality';
import type { Step, StepEntry } from '@/lib/db';

function makeEntry(
  id: string,
  description: string,
  changes: Partial<Step> = {},
  kind: StepEntry['kind'] = 'single',
): StepEntry {
  const step: Step = {
    id,
    sessionId: 'guide-1',
    order: 0,
    screenshotBlob: new Blob(['image'], { type: 'image/png' }),
    bounds: { x: 10, y: 10, width: 20, height: 20 },
    devicePixelRatio: 1,
    description,
    url: `https://example.com/${id}`,
    timestamp: 1,
    ...changes,
  };
  if (kind === 'single') return { kind, step: step as Step & { screenshotBlob: Blob } };
  return {
    kind,
    anchor: { ...step, groupId: id, bounds: null } as Step & { screenshotBlob: Blob },
    annotations: [{ ...step, id: `${id}-annotation`, groupId: id, screenshotBlob: undefined }],
  };
}

const entries = [
  makeEntry('settings', 'Open Settings'),
  makeEntry('snapshot', 'Billing overview', {}, 'group'),
  makeEntry('broken', '', { bounds: null }),
];

function FilterHarness() {
  const [value, setValue] = useState<StepRailFilterValue>({ text: '', kind: 'all', issue: 'all' });
  const report = useMemo(() => analyzeGuideQuality(entries), []);
  const index = useMemo(() => createGuideEntryIndex(entries, report), [report]);
  const filtered = filterGuideEntryIndex(index, value);
  return (
    <>
      <StepRailFilters
        value={value}
        onChange={setValue}
        totalCount={entries.length}
        filteredCount={filtered.length}
        issueCounts={report.issueCounts}
      />
      <ul aria-label="篩選結果">
        {filtered.map((item) => <li key={item.entryId}>{item.entryId}</li>)}
      </ul>
    </>
  );
}

afterEach(cleanup);

describe('StepRailFilters', () => {
  it('provides labelled controls and combines search, kind, and issue filters', () => {
    render(<FilterHarness />);

    expect(screen.getByRole('searchbox', { name: '搜尋步驟說明或網址' })).toBeTruthy();
    expect(screen.getByLabelText('類型')).toBeTruthy();
    expect(screen.getByLabelText('品質問題')).toBeTruthy();
    expect(screen.getByText('顯示 3 / 3 個步驟')).toBeTruthy();

    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'billing' } });
    expect(screen.getByText('顯示 1 / 3 個步驟')).toBeTruthy();
    expect(screen.getByRole('list', { name: '篩選結果' }).textContent).toBe('snapshot');

    fireEvent.change(screen.getByLabelText('類型'), { target: { value: 'single' } });
    expect(screen.getByText('顯示 0 / 3 個步驟')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '清除所有步驟篩選' }));
    fireEvent.change(screen.getByLabelText('品質問題'), { target: { value: 'missing-bounds' } });
    expect(screen.getByText('顯示 1 / 3 個步驟')).toBeTruthy();
    expect(screen.getByRole('list', { name: '篩選結果' }).textContent).toBe('broken');
  });

  it('does not show reset until a filter is active', () => {
    render(<FilterHarness />);
    expect(screen.queryByRole('button', { name: '清除所有步驟篩選' })).toBeNull();
    fireEvent.change(screen.getByLabelText('類型'), { target: { value: 'group' } });
    expect(screen.getByRole('button', { name: '清除所有步驟篩選' })).toBeTruthy();
  });
});

describe('GuideQualityDialog', () => {
  it('summarizes issues accessibly and navigates without rendering screenshots', () => {
    const onOpenChange = vi.fn();
    const onSelectEntry = vi.fn();
    const report = analyzeGuideQuality(entries);

    render(
      <GuideQualityDialog
        open
        onOpenChange={onOpenChange}
        report={report}
        onSelectEntry={onSelectEntry}
      />,
    );

    expect(screen.getByRole('dialog', { name: '教學品質檢查' })).toBeTruthy();
    expect(screen.getByRole('status').textContent).toContain('1 個步驟需要檢查');
    expect(screen.queryByRole('img')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /前往步驟 3/ }));
    expect(onSelectEntry).toHaveBeenCalledWith('broken', 2);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('exposes issue statistics as filter actions when requested', () => {
    const onFilterIssue = vi.fn();
    render(
      <GuideQualityDialog
        open
        onOpenChange={vi.fn()}
        entries={entries}
        onFilterIssue={onFilterIssue}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /缺少說明：1 個步驟；套用篩選/ }));
    expect(onFilterIssue).toHaveBeenCalledWith('empty-description');
  });
});
