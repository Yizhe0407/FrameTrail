// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const database = vi.hoisted(() => ({
  createGuideFromSteps: vi.fn(),
  deleteGuidePermanently: vi.fn(),
  duplicateGuide: vi.fn(),
  getGuideSummaries: vi.fn(),
  getSteps: vi.fn(),
  updateGuide: vi.fn(),
}));
const guideActions = vi.hoisted(() => ({
  clearSelectedGuide: vi.fn(),
  createAndSelectGuide: vi.fn(),
  openSelectedGuideInEditor: vi.fn(),
}));
const storage = vi.hoisted(() => {
  let listener: ((state: any) => void) | null = null;
  return {
    getRecordingState: vi.fn(),
    onRecordingStateChange: vi.fn((next: (state: any) => void) => {
      listener = next;
      return vi.fn();
    }),
    emit(state: any) { listener?.(state); },
  };
});
const archive = vi.hoisted(() => ({
  exportProjectArchive: vi.fn(),
  importProjectArchive: vi.fn(),
  PROJECT_ARCHIVE_LIMITS: { maxArchiveBytes: 128 * 1024 * 1024 },
}));

vi.mock('@/lib/storage/db', () => database);
vi.mock('@/lib/guide/guide-actions', () => guideActions);
vi.mock('@/lib/storage/storage', () => storage);
vi.mock('@/lib/export/project-archive', () => archive);
vi.mock('wxt/browser', () => ({
  browser: { downloads: { download: vi.fn() } },
}));

import LibraryApp from '@/entrypoints/library/App';

const guide = {
  id: 'guide-1',
  title: '安全教學',
  description: '範例',
  sections: [{ id: 'section-1', title: '準備', startEntryId: 'step-1' }],
  createdAt: 1,
  updatedAt: 2,
  archivedAt: null,
  contentRevision: 3,
  stepCount: 2,
  entryCount: 2,
  storageBytes: 100,
};

beforeEach(() => {
  vi.clearAllMocks();
  database.getGuideSummaries.mockResolvedValue([guide]);
  storage.getRecordingState.mockResolvedValue({ operation: null, isRecording: false });
  database.deleteGuidePermanently.mockResolvedValue(undefined);
  guideActions.clearSelectedGuide.mockResolvedValue(undefined);
});

afterEach(() => cleanup());

describe('作品庫', () => {
  it('永久刪除成功後才 compare-and-clear UI selection', async () => {
    const order: string[] = [];
    database.deleteGuidePermanently.mockImplementation(async () => { order.push('delete'); });
    guideActions.clearSelectedGuide.mockImplementation(async () => { order.push('clear'); });
    render(<LibraryApp />);

    fireEvent.click(await screen.findByRole('button', { name: '刪除' }));
    fireEvent.click(screen.getByRole('button', { name: '永久刪除' }));

    await waitFor(() => expect(database.deleteGuidePermanently).toHaveBeenCalledWith('guide-1'));
    expect(guideActions.clearSelectedGuide).toHaveBeenCalledWith('guide-1');
    expect(order).toEqual(['delete', 'clear']);
  });

  it('刪除交易失敗時保留目前 selection', async () => {
    database.deleteGuidePermanently.mockRejectedValue(new Error('durable delete failed'));
    render(<LibraryApp />);

    fireEvent.click(await screen.findByRole('button', { name: '刪除' }));
    fireEvent.click(screen.getByRole('button', { name: '永久刪除' }));

    expect(await screen.findByText('durable delete failed')).toBeTruthy();
    expect(guideActions.clearSelectedGuide).not.toHaveBeenCalled();
  });

  it('即時訂閱全域 operation lock，避免錄製中修改作品庫', async () => {
    render(<LibraryApp />);
    const deleteButton = await screen.findByRole('button', { name: '刪除' }) as HTMLButtonElement;
    expect(deleteButton.disabled).toBe(false);

    storage.emit({ operation: 'recording', isRecording: true });

    await waitFor(() => expect(deleteButton.disabled).toBe(true));
    expect(screen.getByText(/錄製或補拍進行中/)).toBeTruthy();
  });

  it('匯出備份時包含標題、說明與章節 metadata', async () => {
    const steps = [{ id: 'step-1' }];
    database.getSteps.mockResolvedValue(steps);
    archive.exportProjectArchive.mockResolvedValue(new Blob(['archive']));
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:archive');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    render(<LibraryApp />);

    fireEvent.click(await screen.findByRole('button', { name: '備份' }));
    fireEvent.click(screen.getByRole('button', { name: '下載備份' }));

    await waitFor(() => expect(archive.exportProjectArchive).toHaveBeenCalledWith(steps, {
      metadata: {
        title: guide.title,
        description: guide.description,
        sections: guide.sections,
      },
    }));
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:archive');
  });

  it('匯入 v2 備份時由 DB 用同一份 ID map 複製章節 boundary', async () => {
    const imported = {
      version: 2,
      steps: [{ id: 'new-step' }],
      metadata: {
        title: '匯入標題',
        description: '匯入說明',
        sections: [{ id: 'new-section', title: '第一章', startEntryId: 'new-step' }],
      },
    };
    archive.importProjectArchive.mockResolvedValue(imported);
    database.createGuideFromSteps.mockResolvedValue({ id: 'imported-guide' });
    render(<LibraryApp />);

    const input = document.querySelector<HTMLInputElement>('input[type="file"]');
    expect(input).toBeTruthy();
    const file = new File(['archive'], 'fallback.frametrail', { type: 'application/vnd.frametrail.project+json' });
    fireEvent.change(input!, { target: { files: [file] } });

    await waitFor(() => expect(archive.importProjectArchive).toHaveBeenCalledWith(file, { includeMetadata: true }));
    expect(database.createGuideFromSteps).toHaveBeenCalledWith(
      imported.steps,
      { title: '匯入標題', description: '匯入說明' },
      { sections: imported.metadata.sections },
    );
    expect(guideActions.openSelectedGuideInEditor).toHaveBeenCalledWith('imported-guide');
  });

});
