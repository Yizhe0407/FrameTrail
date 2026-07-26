// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { useState } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installStepRailDomStubs, removeStepRailDomStubs } from '../setup/step-rail-dom';
import StepRail from '@/components/editor/StepRail';
import { makeEntry } from '../setup/step-entries';

const ENTRIES = [makeEntry('step-1', 0), makeEntry('step-2', 1), makeEntry('step-3', 2)];

describe('StepRail arrow-key listener stability', () => {
  beforeEach(installStepRailDomStubs);

  afterEach(removeStepRailDomStubs);

  it('registers the window keydown listener once despite parent re-renders', () => {
    const addSpy = vi.spyOn(window, 'addEventListener');
    const removeSpy = vi.spyOn(window, 'removeEventListener');

    function Parent() {
      const [tick, setTick] = useState(0);
      return (
        <>
          <button type="button" onClick={() => setTick((value) => value + 1)}>
            Re-render {tick}
          </button>
          {/* Inline arrow function: a fresh identity on every parent render. */}
          <StepRail
            entries={ENTRIES}
            selectedEntryId="step-1"
            onSelect={(id) => void id}
            onReorder={vi.fn().mockResolvedValue(undefined)}
          />
        </>
      );
    }

    render(<Parent />);
    const keydownAddsAfterMount = addSpy.mock.calls.filter(([type]) => type === 'keydown').length;

    const rerender = screen.getByRole('button', { name: /Re-render/ });
    fireEvent.click(rerender);
    fireEvent.click(rerender);
    fireEvent.click(rerender);

    expect(addSpy.mock.calls.filter(([type]) => type === 'keydown')).toHaveLength(keydownAddsAfterMount);
    expect(removeSpy.mock.calls.filter(([type]) => type === 'keydown')).toHaveLength(0);
  });

  it('navigates with the latest callback and selection after a re-render', () => {
    const selected: string[] = [];

    function Parent() {
      const [selectedEntryId, setSelectedEntryId] = useState('step-1');
      return (
        <StepRail
          entries={ENTRIES}
          selectedEntryId={selectedEntryId}
          onSelect={(id) => {
            selected.push(id);
            setSelectedEntryId(id);
          }}
          onReorder={vi.fn().mockResolvedValue(undefined)}
        />
      );
    }

    render(<Parent />);
    screen.getByRole('button', { name: '開啟步驟 1' }).focus();

    fireEvent.keyDown(window, { key: 'ArrowDown' });
    screen.getByRole('button', { name: '開啟步驟 2' }).focus();
    fireEvent.keyDown(window, { key: 'ArrowDown' });
    screen.getByRole('button', { name: '開啟步驟 3' }).focus();
    fireEvent.keyDown(window, { key: 'ArrowUp' });

    expect(selected).toEqual(['step-2', 'step-3', 'step-2']);
  });
});
