// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { silenceIntentionalErrorLogs } from '../setup/silence-intentional-logs';
import PublishGuideDialog from '@/components/editor/PublishGuideDialog';
import type { StepEntry } from '@/lib/storage/db';

const mocks = vi.hoisted(() => ({
  generateGuideHtml: vi.fn(),
  generateGuideMarkdownArchive: vi.fn(),
  generateGuidePdf: vi.fn(),
  guideExportFilename: vi.fn((_metadata: unknown, format: string) => `guide.${format === 'markdown-archive' ? 'zip' : format === 'markdown' ? 'md' : format}`),
  downloadBlobViaBrowser: vi.fn(),
}));

vi.mock('@/lib/export/guide-export', () => ({
  generateGuideHtml: mocks.generateGuideHtml,
  generateGuideMarkdownArchive: mocks.generateGuideMarkdownArchive,
  generateGuidePdf: mocks.generateGuidePdf,
  guideExportFilename: mocks.guideExportFilename,
}));

vi.mock('@/lib/export/download-utils', () => ({
  downloadBlobViaBrowser: mocks.downloadBlobViaBrowser,
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
      getGuideEntries={() => overrides.guideEntries ?? guideEntries}
      metadata={{ title: '核准教學' }}
      onExportImages={overrides.onExportImages}
    />,
  );
}

describe('PublishGuideDialog', () => {
  it('renders a Traditional Chinese accessible publication dialog and optional image ZIP action', () => {
    renderDialog({ onExportImages: vi.fn() });

    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(screen.getByRole('heading', { name: '匯出' })).toBeTruthy();
    expect(screen.getByRole('button', { name: /下載 Markdown/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /下載 PDF/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /下載圖片/ })).toBeTruthy();
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
    mocks.downloadBlobViaBrowser.mockResolvedValue(undefined);
    render(
      <PublishGuideDialog
        open
        onOpenChange={vi.fn()}
        getGuideEntries={getGuideEntries}
        metadata={{ title: '過期的畫面標題', filename: 'stale-guide' }}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /下載 Markdown/ }));

    await waitFor(() => expect(mocks.downloadBlobViaBrowser).toHaveBeenCalledOnce());
    const signal = getGuideEntries.mock.calls[0][0] as AbortSignal;
    expect(getGuideEntries).toHaveBeenCalledOnce();
    expect(mocks.generateGuideMarkdownArchive).toHaveBeenCalledWith(snapshotEntries, snapshotMetadata, { signal });
    expect(mocks.guideExportFilename).toHaveBeenCalledWith(snapshotMetadata, 'markdown-archive');
    expect(mocks.downloadBlobViaBrowser).toHaveBeenCalledWith(archiveBlob, 'guide.zip', { signal });
    expect((await screen.findByRole('status')).textContent).toContain('Markdown ZIP 已開始下載。');
  });

  it('downloads a PDF using one provider snapshot and current metadata', async () => {
    const snapshotEntries = [{ kind: 'multiple' }] as unknown as readonly StepEntry[];
    const snapshotMetadata = { title: '原子 PDF 教學', filename: 'atomic-pdf-guide' };
    const getGuideEntries = vi.fn().mockResolvedValue({ entries: snapshotEntries, metadata: snapshotMetadata });
    const pdfBlob = new Blob(['pdf'], { type: 'application/pdf' });
    mocks.generateGuidePdf.mockResolvedValue(pdfBlob);
    mocks.downloadBlobViaBrowser.mockResolvedValue(undefined);
    render(
      <PublishGuideDialog
        open
        onOpenChange={vi.fn()}
        getGuideEntries={getGuideEntries}
        metadata={{ title: '過期的畫面標題', filename: 'stale-guide' }}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /下載 PDF/ }));

    await waitFor(() => expect(mocks.downloadBlobViaBrowser).toHaveBeenCalledOnce());
    const signal = getGuideEntries.mock.calls[0][0] as AbortSignal;
    expect(getGuideEntries).toHaveBeenCalledOnce();
    expect(mocks.generateGuidePdf).toHaveBeenCalledWith(snapshotEntries, snapshotMetadata, { signal });
    expect(mocks.guideExportFilename).toHaveBeenCalledWith(snapshotMetadata, 'pdf');
    expect(mocks.downloadBlobViaBrowser).toHaveBeenCalledWith(pdfBlob, 'guide.pdf', { signal });
    expect((await screen.findByRole('status')).textContent).toContain('PDF 已開始下載。');
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
    fireEvent.click(screen.getByRole('button', { name: '關閉' }));

    await waitFor(() => expect(callbackSignal?.aborted).toBe(true));
    expect((await screen.findByRole('status')).textContent).toContain('已取消匯出操作。');
  });

  it('falls back to the shared untitled-guide name when the title is empty', () => {
    render(
      <PublishGuideDialog
        open
        onOpenChange={vi.fn()}
        getGuideEntries={() => guideEntries}
        metadata={{ title: '   ' }}
      />,
    );

    expect(screen.getByText('「未命名作品」')).toBeTruthy();
    expect(screen.queryByText(/登入與初始設定/)).toBeNull();
  });

  it('reports a failed export when the provider resolves no entries', async () => {
    silenceIntentionalErrorLogs();
    renderDialog({ guideEntries: [] });

    fireEvent.click(screen.getByRole('button', { name: /下載 Markdown/ }));

    expect((await screen.findByRole('alert')).textContent).toContain('無法下載 Markdown');
    expect(mocks.generateGuideMarkdownArchive).not.toHaveBeenCalled();
    expect(mocks.downloadBlobViaBrowser).not.toHaveBeenCalled();
  });
});
