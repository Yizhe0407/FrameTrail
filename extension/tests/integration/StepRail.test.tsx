// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import StepRail from '@/components/StepRail';
import type { StepEntry } from '@/lib/db';
import type { GuideSection } from '@/lib/guide-sections';

function makeEntry(id: string, order: number): StepEntry {
  return {
    kind: 'single',
    step: {
      id,
      sessionId: 'session-1',
      order,
      screenshotBlob: new Blob(['image'], { type: 'image/png' }),
      bounds: { x: 10, y: 10, width: 20, height: 20 },
      devicePixelRatio: 1,
      screenshotScale: 1,
      description: `Step ${order + 1}`,
      url: 'https://example.com/',
      timestamp: order,
    },
  };
}

describe('StepRail keyboard navigation', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        disconnect() {}
        unobserve() {}
      },
    );
    vi.stubGlobal('matchMedia', () => ({
      matches: true,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }));
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:step-rail');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    delete (HTMLElement.prototype as { scrollIntoView?: unknown }).scrollIntoView;
  });

  it('只為選取或接近 viewport 的步驟建立圖片 URL', async () => {
    const observers: Array<{ callback: IntersectionObserverCallback; target?: Element }> = [];
    vi.stubGlobal(
      'IntersectionObserver',
      class {
        private record: { callback: IntersectionObserverCallback; target?: Element };
        constructor(callback: IntersectionObserverCallback) {
          this.record = { callback };
          observers.push(this.record);
        }
        observe(target: Element) { this.record.target = target; }
        disconnect() {}
        unobserve() {}
        takeRecords() { return []; }
        root = null;
        rootMargin = '320px';
        thresholds = [0];
      },
    );
    const createObjectURL = vi.spyOn(URL, 'createObjectURL');

    render(
      <StepRail
        entries={[makeEntry('step-1', 0), makeEntry('step-2', 1), makeEntry('step-3', 2)]}
        selectedEntryId="step-1"
        onSelect={vi.fn()}
        onReorder={vi.fn().mockResolvedValue(undefined)}
      />,
    );

    await waitFor(() => expect(createObjectURL).toHaveBeenCalledTimes(1));
    expect(observers).toHaveLength(2);

    act(() => {
      const record = observers[0];
      record.callback([{ isIntersecting: true, target: record.target } as IntersectionObserverEntry], {} as IntersectionObserver);
    });
    await waitFor(() => expect(createObjectURL).toHaveBeenCalledTimes(2));
  });

  it('在手機版提供可展開的搜尋與篩選入口', () => {
    vi.stubGlobal('matchMedia', () => ({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }));
    render(
      <StepRail
        entries={[makeEntry('step-1', 0)]}
        selectedEntryId="step-1"
        onSelect={vi.fn()}
        onReorder={vi.fn().mockResolvedValue(undefined)}
        headerContent={<div>篩選控制項</div>}
      />,
    );

    const toggle = screen.getByRole('button', { name: '搜尋／篩選' });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(toggle);
    expect(screen.getByRole('button', { name: '關閉篩選' }).getAttribute('aria-expanded')).toBe('true');
    expect(screen.getAllByText('篩選控制項')).toHaveLength(2);
  });

  it('handles arrows only while focus is inside the rail', () => {
    const onSelect = vi.fn();
    render(
      <>
        <button type="button">Dialog control</button>
        <StepRail
          entries={[makeEntry('step-1', 0), makeEntry('step-2', 1)]}
          selectedEntryId="step-1"
          onSelect={onSelect}
          onReorder={vi.fn().mockResolvedValue(undefined)}
        />
      </>,
    );

    const railSelection = screen.getByRole('button', { name: '開啟步驟 1' });
    railSelection.focus();
    fireEvent.keyDown(window, { key: 'ArrowDown' });
    expect(onSelect).toHaveBeenCalledWith('step-2', { additive: false, range: false });

    onSelect.mockClear();
    screen.getByRole('button', { name: 'Dialog control' }).focus();
    fireEvent.keyDown(window, { key: 'ArrowDown' });
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('區分開啟與勾選，並傳遞加選及範圍選取修飾鍵', () => {
    const onSelect = vi.fn();
    render(
      <StepRail
        entries={[makeEntry('step-1', 0), makeEntry('step-2', 1)]}
        selectedEntryId="step-1"
        selectedEntryIds={new Set(['step-1'])}
        onSelect={onSelect}
        onReorder={vi.fn().mockResolvedValue(undefined)}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: '開啟步驟 2' }), { ctrlKey: true });
    expect(onSelect).toHaveBeenLastCalledWith('step-2', { additive: true, range: false });

    fireEvent.click(screen.getByRole('button', { name: '開啟步驟 2' }), { shiftKey: true });
    expect(onSelect).toHaveBeenLastCalledWith('step-2', { additive: false, range: true });

    onSelect.mockClear();
    fireEvent.click(screen.getByRole('checkbox', { name: '選取步驟 2' }));
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith('step-2', { additive: true, range: false });
  });

  it('僅在 rail 聚焦時處理全選、收合與 Shift 方向鍵範圍選取', () => {
    const onSelect = vi.fn();
    const onSelectAllVisible = vi.fn();
    const onCollapseSelection = vi.fn();
    render(
      <StepRail
        entries={[makeEntry('step-1', 0), makeEntry('step-2', 1)]}
        selectedEntryId="step-1"
        selectedEntryIds={new Set(['step-1', 'step-2'])}
        onSelect={onSelect}
        onSelectAllVisible={onSelectAllVisible}
        onCollapseSelection={onCollapseSelection}
        onReorder={vi.fn().mockResolvedValue(undefined)}
      />,
    );

    screen.getByRole('button', { name: '開啟步驟 1' }).focus();
    fireEvent.keyDown(window, { key: 'a', ctrlKey: true });
    expect(onSelectAllVisible).toHaveBeenCalledTimes(1);

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onCollapseSelection).toHaveBeenCalledTimes(1);

    fireEvent.keyDown(window, { key: 'ArrowDown', shiftKey: true });
    expect(onSelect).toHaveBeenCalledWith('step-2', { additive: false, range: true });
  });

  it('把章節標題與其起始步驟放在同一個 sortable 項目', () => {
    const sections: GuideSection[] = [{ id: 'section-1', title: '準備工作', startEntryId: 'step-2' }];
    render(
      <StepRail
        entries={[makeEntry('step-1', 0), makeEntry('step-2', 1)]}
        selectedEntryId="step-1"
        sections={sections}
        onSelect={vi.fn()}
        onRenameSection={vi.fn().mockResolvedValue(undefined)}
        onDeleteSection={vi.fn().mockResolvedValue(undefined)}
        onReorder={vi.fn().mockResolvedValue(undefined)}
      />,
    );

    const heading = screen.getByRole('heading', { name: '準備工作', level: 2 });
    const startButton = screen.getByRole('button', { name: '開啟步驟 2' });
    expect(heading.closest('li')).toBe(startButton.closest('li'));
    expect(screen.getByRole('button', { name: '開啟步驟 1' }).closest('li')).not.toBe(heading.closest('li'));
  });

});
