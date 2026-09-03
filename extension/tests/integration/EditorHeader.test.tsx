// @vitest-environment jsdom
import { cleanup, fireEvent, render as rtlRender, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Step } from '@/lib/storage/models';
import { TooltipProvider } from '@/components/ui/tooltip';

// EditorHeader's buttons use the shadcn Tooltip, which requires a
// TooltipProvider ancestor — wrap every render() the same way the app roots do.
function render(ui: Parameters<typeof rtlRender>[0], options?: Parameters<typeof rtlRender>[1]) {
  return rtlRender(ui, { wrapper: TooltipProvider, ...options });
}

const mocks = vi.hoisted(() => ({ openLibrary: vi.fn(), resetSession: vi.fn() }));

vi.mock('@/lib/runtime/actions', () => ({
  openLibrary: mocks.openLibrary,
  resetSession: mocks.resetSession,
}));

import EditorHeader from '@/components/editor/EditorHeader';

const steps = [{ id: 'step-1' }] as Step[];

function renderHeader(overrides: Partial<React.ComponentProps<typeof EditorHeader>> = {}) {
  return render(
    <EditorHeader
      operationActive={false}
      steps={steps}
      sessionId="guide-1"
      onOpenPublish={vi.fn()}
      {...overrides}
    />,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.openLibrary.mockResolvedValue(undefined);
  mocks.resetSession.mockResolvedValue(undefined);
});

afterEach(cleanup);

describe('EditorHeader', () => {
  // The header used to render every action twice — an icon-only button below
  // `sm` beside a labelled one from `sm` up — which doubled the click targets,
  // accessible names and disabled logic that had to stay in sync.
  it('offers exactly one control per action', () => {
    renderHeader();

    expect(screen.getAllByRole('button', { name: '作品庫' })).toHaveLength(1);
    expect(screen.getAllByRole('button', { name: '匯出' })).toHaveLength(1);
    expect(screen.getAllByRole('button', { name: '重置目前錄製' })).toHaveLength(1);
  });

  it('keeps the accessible name complete while the visible label collapses below sm', () => {
    renderHeader();

    for (const [name, label] of [['作品庫', '作品庫'], ['匯出', '匯出']]) {
      const button = screen.getByRole('button', { name });
      // The icon is always rendered; only the text label is width-dependent, so
      // the name has to come from `aria-label` rather than the hidden span.
      expect(button.querySelector('svg')).toBeTruthy();
      expect(button.getAttribute('aria-label')).toBe(name);
      expect(within(button).getByText(label).className).toContain('hidden sm:inline');
    }
    // The button no longer carries a native title; the same copy now surfaces
    // through the shadcn Tooltip, which opens on focus.
    fireEvent.focus(screen.getByRole('button', { name: '作品庫' }));
    expect(screen.getByRole('tooltip').textContent).toBe('回到作品庫');
  });

  it('opens the library from the single 作品庫 control', () => {
    renderHeader();

    fireEvent.click(screen.getByRole('button', { name: '作品庫' }));

    expect(mocks.openLibrary).toHaveBeenCalledOnce();
  });

  it.each<[string, Partial<React.ComponentProps<typeof EditorHeader>>]>([
    ['an operation is running', { operationActive: true }],
    ['editing is disabled', { editingDisabled: true }],
    ['the guide has no steps', { steps: [] }],
    ['no publish handler is wired', { onOpenPublish: undefined }],
  ])('disables 匯出 when %s', (_label, overrides) => {
    renderHeader(overrides);

    expect((screen.getByRole('button', { name: '匯出' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('enables 匯出 once there is something to export', () => {
    renderHeader();

    expect((screen.getByRole('button', { name: '匯出' }) as HTMLButtonElement).disabled).toBe(false);
  });
});
