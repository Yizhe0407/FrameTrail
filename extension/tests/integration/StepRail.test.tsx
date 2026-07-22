// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import StepRail from '@/components/StepRail';
import type { StepEntry } from '@/lib/db';

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

    const railSelection = screen.getByRole('button', { name: '選取步驟 1' });
    railSelection.focus();
    fireEvent.keyDown(window, { key: 'ArrowDown' });
    expect(onSelect).toHaveBeenCalledWith('step-2');

    onSelect.mockClear();
    screen.getByRole('button', { name: 'Dialog control' }).focus();
    fireEvent.keyDown(window, { key: 'ArrowDown' });
    expect(onSelect).not.toHaveBeenCalled();
  });
});
