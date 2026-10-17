// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { silenceIntentionalErrorLogs } from '../setup/silence-intentional-logs';
import PublishProjectDialog from '@/components/editor/PublishProjectDialog';
import { DownloadFailedError, RedactionReviewRequiredError, StepImageError } from '@/lib/export/export-errors';
import { type StepEntry } from '@/lib/storage/models';

const mocks = vi.hoisted(() => ({
  generateProjectHtml: vi.fn(),
  generateProjectMarkdownArchive: vi.fn(),
  generateProjectPdf: vi.fn(),
  projectExportFilename: vi.fn((_metadata: unknown, format: string) => `project.${format === 'markdown-archive' ? 'zip' : format === 'markdown' ? 'md' : format}`),
  downloadBlobViaBrowser: vi.fn(),
}));

vi.mock('@/lib/export/project-export-html', () => ({ generateProjectHtml: mocks.generateProjectHtml }));
vi.mock('@/lib/export/project-export-markdown', () => ({ generateProjectMarkdownArchive: mocks.generateProjectMarkdownArchive }));
vi.mock('@/lib/export/project-export-pdf', () => ({ generateProjectPdf: mocks.generateProjectPdf }));
vi.mock('@/lib/export/project-export-contract', () => ({
  projectExportFilename: mocks.projectExportFilename,
}));

vi.mock('@/lib/export/download-utils', () => ({
  downloadBlobViaBrowser: mocks.downloadBlobViaBrowser,
  throwIfDownloadAborted: (signal?: AbortSignal) => {
    if (signal?.aborted) throw new DOMException('cancelled', 'AbortError');
  },
}));

const projectEntries = [{ kind: 'single' }] as unknown as readonly StepEntry[];

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function renderDialog(overrides: {
  projectEntries?: readonly StepEntry[];
  onOpenChange?: (open: boolean) => void;
  onExportImages?: (signal: AbortSignal) => void | Promise<void>;
} = {}) {
  return render(
    <PublishProjectDialog
      open
      onOpenChange={overrides.onOpenChange ?? vi.fn()}
      getProjectEntries={() => overrides.projectEntries ?? projectEntries}
      metadata={{ title: '核准教學' }}
      onExportImages={overrides.onExportImages}
    />,
  );
}

describe('PublishProjectDialog', () => {
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
    const snapshotMetadata = { title: '目前教學', filename: 'current-project' };
    const getProjectEntries = vi.fn().mockResolvedValue({ entries: snapshotEntries, metadata: snapshotMetadata });
    const archiveBlob = new Blob(['zip'], { type: 'application/zip' });
    mocks.generateProjectMarkdownArchive.mockResolvedValue({
      blob: archiveBlob,
      markdownFilename: 'current-project.md',
      imageCount: 1,
    });
    mocks.downloadBlobViaBrowser.mockResolvedValue(undefined);
    render(
      <PublishProjectDialog
        open
        onOpenChange={vi.fn()}
        getProjectEntries={getProjectEntries}
        metadata={{ title: '過期的畫面標題', filename: 'stale-project' }}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /下載 Markdown/ }));

    await waitFor(() => expect(mocks.downloadBlobViaBrowser).toHaveBeenCalledOnce());
    const signal = getProjectEntries.mock.calls[0][0] as AbortSignal;
    expect(getProjectEntries).toHaveBeenCalledOnce();
    expect(mocks.generateProjectMarkdownArchive).toHaveBeenCalledWith(snapshotEntries, snapshotMetadata, { signal });
    expect(mocks.projectExportFilename).toHaveBeenCalledWith(snapshotMetadata, 'markdown-archive');
    expect(mocks.downloadBlobViaBrowser).toHaveBeenCalledWith(archiveBlob, 'project.zip', { signal });
    expect((await screen.findByRole('status')).textContent).toContain('Markdown ZIP 已開始下載。');
  });

  it('downloads a PDF using one provider snapshot and current metadata', async () => {
    const snapshotEntries = [{ kind: 'multiple' }] as unknown as readonly StepEntry[];
    const snapshotMetadata = { title: '原子 PDF 教學', filename: 'atomic-pdf-project' };
    const getProjectEntries = vi.fn().mockResolvedValue({ entries: snapshotEntries, metadata: snapshotMetadata });
    const pdfBlob = new Blob(['pdf'], { type: 'application/pdf' });
    mocks.generateProjectPdf.mockResolvedValue(pdfBlob);
    mocks.downloadBlobViaBrowser.mockResolvedValue(undefined);
    render(
      <PublishProjectDialog
        open
        onOpenChange={vi.fn()}
        getProjectEntries={getProjectEntries}
        metadata={{ title: '過期的畫面標題', filename: 'stale-project' }}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /下載 PDF/ }));

    await waitFor(() => expect(mocks.downloadBlobViaBrowser).toHaveBeenCalledOnce());
    const signal = getProjectEntries.mock.calls[0][0] as AbortSignal;
    expect(getProjectEntries).toHaveBeenCalledOnce();
    expect(mocks.generateProjectPdf).toHaveBeenCalledWith(snapshotEntries, snapshotMetadata, { signal });
    expect(mocks.projectExportFilename).toHaveBeenCalledWith(snapshotMetadata, 'pdf');
    expect(mocks.downloadBlobViaBrowser).toHaveBeenCalledWith(pdfBlob, 'project.pdf', { signal });
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

  it('falls back to the shared untitled-project name when the title is empty', () => {
    render(
      <PublishProjectDialog
        open
        onOpenChange={vi.fn()}
        getProjectEntries={() => projectEntries}
        metadata={{ title: '   ' }}
      />,
    );

    expect(screen.getByText('「未命名專案」')).toBeTruthy();
    expect(screen.queryByText(/登入與初始設定/)).toBeNull();
  });

  it('downloads the HTML Blob as generated, without copying it into a string', async () => {
    const htmlBlob = new Blob(['<!doctype html>'], { type: 'text/html;charset=utf-8' });
    mocks.generateProjectHtml.mockResolvedValue(htmlBlob);
    mocks.downloadBlobViaBrowser.mockResolvedValue(undefined);
    renderDialog();

    fireEvent.click(screen.getByRole('button', { name: /下載 HTML 網頁/ }));

    await waitFor(() => expect(mocks.downloadBlobViaBrowser).toHaveBeenCalledOnce());
    expect(mocks.downloadBlobViaBrowser.mock.calls[0][0]).toBe(htmlBlob);
    expect((await screen.findByRole('status')).textContent).toContain('HTML 網頁已開始下載。');
  });

  it('names the step whose image could not be read instead of blaming the masks', async () => {
    silenceIntentionalErrorLogs();
    mocks.generateProjectHtml.mockRejectedValue(new StepImageError(7, new Error('InvalidStateError')));
    renderDialog();

    fireEvent.click(screen.getByRole('button', { name: /下載 HTML 網頁/ }));

    const alert = (await screen.findByRole('alert')).textContent ?? '';
    expect(alert).toContain('第 7 步的圖片無法讀取');
    expect(alert).not.toContain('遮罩後再試一次');
    expect(mocks.downloadBlobViaBrowser).not.toHaveBeenCalled();
  });

  it('lists the steps whose masks still need review', async () => {
    silenceIntentionalErrorLogs();
    mocks.generateProjectPdf.mockRejectedValue(new RedactionReviewRequiredError([2, 5]));
    renderDialog();

    fireEvent.click(screen.getByRole('button', { name: /下載 PDF/ }));

    expect((await screen.findByRole('alert')).textContent).toContain('敏感資訊遮罩尚待檢查，匯出已中止：2, 5。');
  });

  it('reports a rejected browser download with its own message', async () => {
    silenceIntentionalErrorLogs();
    mocks.generateProjectPdf.mockResolvedValue(new Blob(['pdf']));
    mocks.downloadBlobViaBrowser.mockRejectedValue(new DownloadFailedError(new Error('Invalid filename')));
    renderDialog();

    fireEvent.click(screen.getByRole('button', { name: /下載 PDF/ }));

    const alert = (await screen.findByRole('alert')).textContent ?? '';
    expect(alert).toContain('瀏覽器無法開始下載檔案');
    expect(alert).not.toContain('敏感資訊遮罩');
  });

  it('tells the user nothing was exported when the image ZIP has no images', async () => {
    renderDialog({ onExportImages: vi.fn().mockResolvedValue(null) });

    fireEvent.click(screen.getByRole('button', { name: /下載圖片/ }));

    const status = (await screen.findByRole('status')).textContent ?? '';
    expect(status).toContain('沒有可匯出的圖片');
    expect(status).not.toContain('已開始下載');
  });

  it('reports a failed export when the provider resolves no entries', async () => {
    silenceIntentionalErrorLogs();
    renderDialog({ projectEntries: [] });

    fireEvent.click(screen.getByRole('button', { name: /下載 Markdown/ }));

    expect((await screen.findByRole('alert')).textContent).toContain('無法下載 Markdown');
    expect(mocks.generateProjectMarkdownArchive).not.toHaveBeenCalled();
    expect(mocks.downloadBlobViaBrowser).not.toHaveBeenCalled();
  });
});
