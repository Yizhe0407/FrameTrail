// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import PublishGuideDialog from '@/components/editor/PublishGuideDialog';
import type { StepEntry } from '@/lib/storage/db';

const mocks = vi.hoisted(() => ({
  generateGuideMarkdownArchive: vi.fn(),
  generateGuideHtml: vi.fn(),
  guideExportFilename: vi.fn((_metadata: unknown, format: string) => `guide.${format === 'markdown-archive' ? 'zip' : format === 'markdown' ? 'md' : 'html'}`),
  downloadBlob: vi.fn(),
  downloadText: vi.fn(),
}));

vi.mock('@/lib/export/guide-export', () => ({
  generateGuideMarkdownArchive: mocks.generateGuideMarkdownArchive,
  generateGuideHtml: mocks.generateGuideHtml,
  guideExportFilename: mocks.guideExportFilename,
}));

vi.mock('@/lib/export/download-utils', () => ({
  downloadBlob: mocks.downloadBlob,
  downloadText: mocks.downloadText,
  throwIfDownloadAborted: (signal?: AbortSignal) => {
    if (signal?.aborted) throw new DOMException('cancelled', 'AbortError');
  },
}));

const guideEntries = [{ kind: 'single' }] as unknown as readonly StepEntry[];

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function renderDialog(overrides: {
  guideEntries?: readonly StepEntry[];
  onOpenChange?: (open: boolean) => void;
  onExportImages?: (signal: AbortSignal) => void | Promise<void>;
} = {}) {
  return render(
    <PublishGuideDialog
      open
      onOpenChange={overrides.onOpenChange ?? vi.fn()}
      guideEntries={overrides.guideEntries ?? guideEntries}
      metadata={{ title: '核准教學' }}
      onExportImages={overrides.onExportImages}
    />,
  );
}

describe('PublishGuideDialog', () => {
  it('renders a Traditional Chinese accessible publication dialog and optional image ZIP action', () => {
    renderDialog({ onExportImages: vi.fn() });

    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(screen.getByRole('heading', { name: '發佈教學' })).toBeTruthy();
    expect(screen.getByRole('button', { name: /下載 Markdown/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /下載自包含 HTML/ })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /開啟列印版/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /複製完整教學/ })).toBeNull();
    expect(screen.queryByRole('heading', { name: '快速複製' })).toBeNull();
    expect(screen.getByRole('button', { name: /下載圖片/ })).toBeTruthy();
    expect(screen.getByRole('heading', { name: '推薦格式' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: '其他下載方式' })).toBeTruthy();
    expect(screen.getByText('檔案僅在此裝置上產生')).toBeTruthy();
  });

  it('downloads a Markdown ZIP using one provider snapshot and current metadata', async () => {
    const snapshotEntries = [{ kind: 'multiple' }] as unknown as readonly StepEntry[];
    const snapshotMetadata = { title: '目前教學', filename: 'current-guide' };
    const getGuideEntries = vi.fn().mockResolvedValue({ entries: snapshotEntries, metadata: snapshotMetadata });
    const archiveBlob = new Blob(['zip'], { type: 'application/zip' });
    mocks.generateGuideMarkdownArchive.mockResolvedValue({
      blob: archiveBlob,
      markdownFilename: 'current-guide.md',
      imageCount: 1,
    });
    mocks.downloadBlob.mockResolvedValue(undefined);
    render(
      <PublishGuideDialog
        open
        onOpenChange={vi.fn()}
        getGuideEntries={getGuideEntries}
        metadata={{ title: '過期的畫面標題', filename: 'stale-guide' }}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /下載 Markdown/ }));

    await waitFor(() => expect(mocks.downloadBlob).toHaveBeenCalledOnce());
    const signal = getGuideEntries.mock.calls[0][0] as AbortSignal;
    expect(getGuideEntries).toHaveBeenCalledOnce();
    expect(mocks.generateGuideMarkdownArchive).toHaveBeenCalledWith(snapshotEntries, snapshotMetadata, { signal });
    expect(mocks.guideExportFilename).toHaveBeenCalledWith(snapshotMetadata, 'markdown-archive');
    expect(mocks.downloadBlob).toHaveBeenCalledWith(archiveBlob, 'guide.zip', { signal });
    expect(mocks.downloadText).not.toHaveBeenCalled();
    expect((await screen.findByRole('status')).textContent).toContain('Markdown ZIP 已開始下載。');
  });

  it('uses one provider snapshot for HTML entries, metadata, and filename', async () => {
    const snapshotEntries = [{ kind: 'multiple' }] as unknown as readonly StepEntry[];
    const snapshotMetadata = { title: '原子 HTML 教學', filename: 'atomic-html-guide' };
    const getGuideEntries = vi.fn().mockResolvedValue({ entries: snapshotEntries, metadata: snapshotMetadata });
    mocks.generateGuideHtml.mockResolvedValue('<!doctype html><main>原子 HTML 教學</main>');
    mocks.downloadText.mockResolvedValue(undefined);
    render(
      <PublishGuideDialog
        open
        onOpenChange={vi.fn()}
        getGuideEntries={getGuideEntries}
        metadata={{ title: '過期的畫面標題', filename: 'stale-guide' }}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /下載自包含 HTML/ }));

    await waitFor(() => expect(mocks.downloadText).toHaveBeenCalledOnce());
    const signal = getGuideEntries.mock.calls[0][0] as AbortSignal;
    expect(getGuideEntries).toHaveBeenCalledOnce();
    expect(mocks.generateGuideHtml).toHaveBeenCalledWith(snapshotEntries, snapshotMetadata, { signal });
    expect(mocks.guideExportFilename).toHaveBeenCalledWith(snapshotMetadata, 'html');
    expect(mocks.downloadText).toHaveBeenCalledWith(
      '<!doctype html><main>原子 HTML 教學</main>',
      'guide.html',
      'text/html;charset=utf-8',
      { signal },
    );
  });

  it('passes an abortable signal to the existing image ZIP callback and cancels it', async () => {
    let callbackSignal: AbortSignal | undefined;
    const onExportImages = vi.fn((signal: AbortSignal) => {
      callbackSignal = signal;
      return new Promise<void>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new DOMException('cancelled', 'AbortError')), { once: true });
      });
    });
    renderDialog({ onExportImages });

    fireEvent.click(screen.getByRole('button', { name: /下載圖片/ }));
    await waitFor(() => expect(onExportImages).toHaveBeenCalledOnce());
    fireEvent.click(screen.getByRole('button', { name: /取消下載圖片/ }));

    await waitFor(() => expect(callbackSignal?.aborted).toBe(true));
    expect((await screen.findByRole('status')).textContent).toContain('已取消發佈操作。');
  });

  it('disables publication actions when the guide entry set is empty', () => {
    renderDialog({ guideEntries: [] });

    expect(screen.getByText('目前沒有可供發佈的步驟。')).toBeTruthy();
    expect((screen.getByRole('button', { name: /下載 Markdown/ }) as HTMLButtonElement).disabled).toBe(true);
  });
});
