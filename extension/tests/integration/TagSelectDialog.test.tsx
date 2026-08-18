// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GuideSummary } from '@/lib/storage/models';

const database = vi.hoisted(() => ({ getGuideSummaries: vi.fn() }));

vi.mock('@/lib/storage/guide-repository', () => ({ getGuideSummaries: database.getGuideSummaries }));

import TagSelectDialog from '@/components/editor/TagSelectDialog';

const INVENTED_PRESETS = ['入門', '團隊', '專案', '整合', '報表', '行動', '說明', '設定'];

function summary(tags: string[]): GuideSummary {
  return { tags } as GuideSummary;
}

function renderDialog(selectedTags: readonly string[] = [], onSave = vi.fn()) {
  render(
    <TagSelectDialog
      open
      selectedTags={selectedTags}
      onOpenChange={vi.fn()}
      onSave={onSave}
    />,
  );
  return onSave;
}

beforeEach(() => {
  vi.clearAllMocks();
  database.getGuideSummaries.mockResolvedValue([]);
});

afterEach(cleanup);

describe('TagSelectDialog', () => {
  // The dialog used to hardcode a taxonomy the UI invented, which filled most
  // of the panel and pushed the real input down.
  it('offers no invented preset vocabulary', async () => {
    renderDialog();

    expect(await screen.findByPlaceholderText('輸入後按 Enter')).toBeTruthy();
    for (const preset of INVENTED_PRESETS) {
      expect(screen.queryByRole('button', { name: `新增 ${preset} 標籤` })).toBeNull();
    }
  });

  it('adds a sanitized free-text tag from Enter and from the add button', async () => {
    const onSave = renderDialog(['既有']);
    const input = screen.getByPlaceholderText('輸入後按 Enter');

    fireEvent.change(input, { target: { value: '  流程  ' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(onSave).toHaveBeenCalledWith(['既有', '流程']));

    fireEvent.change(input, { target: { value: '驗收' } });
    fireEvent.click(screen.getByRole('button', { name: '新增標籤' }));
    await waitFor(() => expect(onSave).toHaveBeenCalledWith(['既有', '驗收']));
  });

  // Tags the user already applied elsewhere are a real signal, and guide
  // summaries are denormalized rows, so reading them opens no screenshot Blob.
  it('suggests tags already used across the library, minus the ones already applied', async () => {
    database.getGuideSummaries.mockResolvedValue([summary(['驗收', '交付']), summary(['交付'])]);
    const onSave = renderDialog(['驗收']);

    const suggestion = await screen.findByRole('button', { name: '新增 交付 標籤' });
    expect(screen.queryByRole('button', { name: '新增 驗收 標籤' })).toBeNull();

    fireEvent.click(suggestion);

    await waitFor(() => expect(onSave).toHaveBeenCalledWith(['驗收', '交付']));
  });

  it('still accepts free text when the suggestion read fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    database.getGuideSummaries.mockRejectedValue(new Error('IndexedDB is unavailable'));
    const onSave = renderDialog();

    const input = await screen.findByPlaceholderText('輸入後按 Enter');
    fireEvent.change(input, { target: { value: '流程' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => expect(onSave).toHaveBeenCalledWith(['流程']));
    expect(screen.queryByRole('alert')).toBeNull();
    await waitFor(() => expect(warn).toHaveBeenCalled());
  });

  // Removal belongs to the inline chips on the stage behind this dialog, which
  // the user reaches without opening anything; a second remove button here
  // would be a second independent path to the same write.
  it('shows the current tags without a second remove path', async () => {
    renderDialog(['驗收']);

    expect(await screen.findByText('目前標籤')).toBeTruthy();
    expect(screen.getByText('驗收')).toBeTruthy();
    expect(screen.queryByRole('button', { name: '移除 驗收 標籤' })).toBeNull();
  });

  it('surfaces a failed write inline, where the modal cannot aria-hide it', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const onSave = vi.fn().mockRejectedValue(new Error('目前有其他操作進行中，請稍後再修改。'));
    renderDialog([], onSave);

    const input = screen.getByPlaceholderText('輸入後按 Enter');
    fireEvent.change(input, { target: { value: '流程' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect((await screen.findByRole('alert')).textContent).toContain('目前有其他操作進行中');
    consoleError.mockRestore();
  });
});
