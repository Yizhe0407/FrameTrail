// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
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
const downloads = vi.hoisted(() => ({ download: vi.fn() }));
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
  browser: { downloads },
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
  downloads.download.mockResolvedValue(1);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

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

  it('初次確認錄製狀態前停用新增與匯入操作', async () => {
    let resolveState!: (state: { operation: null; isRecording: false }) => void;
    storage.getRecordingState.mockReturnValueOnce(new Promise((resolve) => {
      resolveState = resolve;
    }));
    render(<LibraryApp />);

    expect((screen.getByRole('button', { name: '匯入檔案' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: '新增教學' }) as HTMLButtonElement).disabled).toBe(true);

    await act(async () => { resolveState({ operation: null, isRecording: false }); });
    await waitFor(() => expect((screen.getByRole('button', { name: '新增教學' }) as HTMLButtonElement).disabled).toBe(false));
  });

  it('即時訂閱全域 operation lock，避免錄製中修改作品庫', async () => {
    render(<LibraryApp />);
    const deleteButton = await screen.findByRole('button', { name: '刪除' }) as HTMLButtonElement;
    expect(deleteButton.disabled).toBe(false);

    storage.emit({ operation: 'recording', isRecording: true });

    await waitFor(() => expect(deleteButton.disabled).toBe(true));
    expect(screen.getByText(/錄製或補拍進行中/)).toBeTruthy();
  });

  it('資料異動後在背景更新清單，不以載入畫面取代現有卡片', async () => {
    let resolveRefresh!: (guides: typeof guide[]) => void;
    const pendingRefresh = new Promise<typeof guide[]>((resolve) => {
      resolveRefresh = resolve;
    });
    database.getGuideSummaries
      .mockResolvedValueOnce([guide])
      .mockReturnValueOnce(pendingRefresh);
    render(<LibraryApp />);

    fireEvent.click(await screen.findByRole('button', { name: '封存' }));

    await waitFor(() => expect(database.getGuideSummaries).toHaveBeenCalledTimes(2));
    expect(screen.getByDisplayValue(guide.title)).toBeTruthy();
    expect(screen.queryByText('讀取作品庫…')).toBeNull();

    await act(async () => { resolveRefresh([]); });
    await waitFor(() => expect(screen.queryByDisplayValue(guide.title)).toBeNull());
  });

  it('匯出可編輯檔案時包含完整 metadata、使用安全檔名且不重新載入作品庫', async () => {
    const steps = [{ id: 'step-1' }];
    database.getSteps.mockResolvedValue(steps);
    archive.exportProjectArchive.mockResolvedValue(new Blob(['archive']));
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:archive');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    render(<LibraryApp />);

    fireEvent.click(await screen.findByRole('button', { name: '匯出 安全教學' }));
    expect(screen.getByText(/安全教學\.frametrail/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '下載 .frametrail' }));

    await waitFor(() => expect(archive.exportProjectArchive).toHaveBeenCalledWith(steps, {
      metadata: {
        title: guide.title,
        description: guide.description,
        sections: guide.sections,
      },
    }));
    expect(downloads.download).toHaveBeenCalledWith({
      url: 'blob:archive',
      filename: '安全教學.frametrail',
      saveAs: true,
      conflictAction: 'uniquify',
    });
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:archive');
    expect(await screen.findByText('「安全教學」的可編輯檔案已開始下載。')).toBeTruthy();
    expect(database.getGuideSummaries).toHaveBeenCalledOnce();
  });

  it('匯出失敗時保留作品卡片、顯示錯誤並允許重試', async () => {
    database.getSteps.mockResolvedValue([{ id: 'step-1' }]);
    archive.exportProjectArchive.mockRejectedValueOnce(new Error('匯出空間不足'));
    render(<LibraryApp />);

    fireEvent.click(await screen.findByRole('button', { name: '匯出 安全教學' }));
    fireEvent.click(screen.getByRole('button', { name: '下載 .frametrail' }));

    expect((await screen.findByRole('alert')).textContent).toContain('匯出空間不足');
    expect(screen.getByDisplayValue(guide.title)).toBeTruthy();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect((screen.getByRole('button', { name: '匯出 安全教學' }) as HTMLButtonElement).disabled).toBe(false);
    expect(database.getGuideSummaries).toHaveBeenCalledOnce();
  });

  it('匯入失敗時保留作品卡片並以 alert 公告錯誤', async () => {
    archive.importProjectArchive.mockRejectedValue(new Error('檔案內容損毀'));
    render(<LibraryApp />);

    const input = document.querySelector<HTMLInputElement>('input[type="file"]');
    await waitFor(() => expect((screen.getByRole('button', { name: '匯入檔案' }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.change(input!, {
      target: { files: [new File(['broken'], 'broken.frametrail')] },
    });

    expect((await screen.findByRole('alert')).textContent).toContain('檔案內容損毀');
    expect(screen.getByDisplayValue(guide.title)).toBeTruthy();
    expect(database.createGuideFromSteps).not.toHaveBeenCalled();
    expect(database.getGuideSummaries).toHaveBeenCalledOnce();
  });

  it('同一事件迴圈內不會啟動兩個重疊的作品庫寫入', async () => {
    let resolveDuplicate!: () => void;
    database.duplicateGuide.mockReturnValue(new Promise<void>((resolve) => {
      resolveDuplicate = resolve;
    }));
    render(<LibraryApp />);

    const duplicate = await screen.findByRole('button', { name: '複製' });
    fireEvent.click(duplicate);
    fireEvent.click(duplicate);

    expect(database.duplicateGuide).toHaveBeenCalledOnce();
    await act(async () => { resolveDuplicate(); });
  });

  it('匯入 v2 可編輯檔案時由 DB 用同一份 ID map 複製章節 boundary', async () => {
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
    await waitFor(() => expect((screen.getByRole('button', { name: '匯入檔案' }) as HTMLButtonElement).disabled).toBe(false));
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
