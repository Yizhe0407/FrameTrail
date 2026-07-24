// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import StepRail from '@/components/editor/StepRail';
import type { StepEntry } from '@/lib/storage/db';
import type { GuideSection } from '@/lib/guide/guide-sections';

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

function makeGroupEntry(id: string, annotationCount: number): StepEntry {
  const single = makeEntry(id, 0);
  if (single.kind !== 'single') throw new Error('Expected a single entry fixture.');
  return {
    kind: 'group',
    anchor: { ...single.step, bounds: null, groupId: id },
    annotations: Array.from({ length: annotationCount }, (_, index) => {
      const annotation = makeEntry(`${id}-annotation-${index + 1}`, index + 1);
      if (annotation.kind !== 'single') throw new Error('Expected a single annotation fixture.');
      const { screenshotBlob: _screenshotBlob, ...step } = annotation.step;
      return { ...step, groupId: id };
    }),
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
    expect(onSelect).toHaveBeenCalledWith('step-2');

    onSelect.mockClear();
    screen.getByRole('button', { name: 'Dialog control' }).focus();
    fireEvent.keyDown(window, { key: 'ArrowDown' });
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('不在左側欄顯示單頁標註類型或標註數量', () => {
    render(
      <StepRail
        entries={[makeGroupEntry('snapshot-1', 2)]}
        selectedEntryId="snapshot-1"
        onSelect={vi.fn()}
        onReorder={vi.fn().mockResolvedValue(undefined)}
      />,
    );

    const rail = screen.getByRole('navigation', { name: '步驟導覽' });
    expect(rail.textContent).not.toContain('單頁標註');
    expect(rail.textContent).not.toContain('2 個標註');
  });

  it('只顯示單一目前步驟，不提供批次選取控制', () => {
    render(
      <StepRail
        entries={[makeEntry('step-1', 0), makeEntry('step-2', 1)]}
        selectedEntryId="step-1"
        onSelect={vi.fn()}
        onReorder={vi.fn().mockResolvedValue(undefined)}
      />,
    );

    expect(screen.getByRole('button', { name: '開啟步驟 1' }).getAttribute('aria-current')).toBe('step');
    expect(screen.getByRole('button', { name: '開啟步驟 2' }).getAttribute('aria-current')).toBeNull();
    expect(screen.queryByRole('button', { name: /選取步驟/ })).toBeNull();
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
