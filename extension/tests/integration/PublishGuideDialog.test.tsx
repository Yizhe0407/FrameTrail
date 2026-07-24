// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import PublishGuideDialog from '@/components/editor/PublishGuideDialog';
import type { StepEntry } from '@/lib/storage/db';

const mocks = vi.hoisted(() => ({
  generateGuideMarkdown: vi.fn(),
  generateGuideHtml: vi.fn(),
  generatePrintReadyGuideHtml: vi.fn(),
  guideExportFilename: vi.fn((_metadata: unknown, format: string) => `guide.${format === 'markdown' ? 'md' : 'html'}`),
  copyRichText: vi.fn(),
  downloadText: vi.fn(),
  loadHtmlIntoWindow: vi.fn(),
  openPrintPlaceholder: vi.fn(),
}));

vi.mock('@/lib/export/guide-export', () => ({
  generateGuideMarkdown: mocks.generateGuideMarkdown,
  generateGuideHtml: mocks.generateGuideHtml,
  generatePrintReadyGuideHtml: mocks.generatePrintReadyGuideHtml,
  guideExportFilename: mocks.guideExportFilename,
}));

vi.mock('@/lib/export/download-utils', () => ({
  copyRichText: mocks.copyRichText,
  downloadText: mocks.downloadText,
  loadHtmlIntoWindow: mocks.loadHtmlIntoWindow,
  openPrintPlaceholder: mocks.openPrintPlaceholder,
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
    expect(screen.getByRole('button', { name: /開啟列印版/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /複製完整教學/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /下載圖片 ZIP/ })).toBeTruthy();
    expect(screen.getByRole('heading', { name: '推薦格式' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: '其他下載方式' })).toBeTruthy();
    expect(screen.getByText('檔案僅在此裝置上產生')).toBeTruthy();
    expect(screen.getByText(/另存為 PDF/)).toBeTruthy();
  });

  it('uses provider snapshot metadata instead of stale render-time metadata for Markdown', async () => {
    const snapshotEntries = [{ kind: 'multiple' }] as unknown as readonly StepEntry[];
    const snapshotMetadata = { title: '目前教學', filename: 'current-guide' };
    const getGuideEntries = vi.fn().mockResolvedValue({ entries: snapshotEntries, metadata: snapshotMetadata });
    mocks.generateGuideMarkdown.mockResolvedValue('# 目前教學');
    mocks.downloadText.mockResolvedValue(undefined);
    render(
      <PublishGuideDialog
        open
        onOpenChange={vi.fn()}
        getGuideEntries={getGuideEntries}
        metadata={{ title: '過期的畫面標題', filename: 'stale-guide' }}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /下載 Markdown/ }));

    await waitFor(() => expect(mocks.downloadText).toHaveBeenCalledOnce());
    const signal = getGuideEntries.mock.calls[0][0] as AbortSignal;
    expect(getGuideEntries).toHaveBeenCalledOnce();
    expect(mocks.generateGuideMarkdown).toHaveBeenCalledWith(snapshotEntries, snapshotMetadata, { signal });
    expect(mocks.guideExportFilename).toHaveBeenCalledWith(snapshotMetadata, 'markdown');
    expect(mocks.downloadText).toHaveBeenCalledWith(
      '# 目前教學',
      'guide.md',
      'text/markdown;charset=utf-8',
      { signal },
    );
    expect((await screen.findByRole('status')).textContent).toContain('Markdown 已開始下載。');
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

  it('copies generated HTML and Markdown together instead of accepting pre-rendered content', async () => {
    mocks.generateGuideHtml.mockResolvedValue('<!doctype html><main>核准教學</main>');
    mocks.generateGuideMarkdown.mockResolvedValue('# 核准教學');
    mocks.copyRichText.mockResolvedValue(undefined);
    renderDialog();

    fireEvent.click(screen.getByRole('button', { name: /複製完整教學/ }));

    await waitFor(() => expect(mocks.copyRichText).toHaveBeenCalledOnce());
    const signal = mocks.generateGuideHtml.mock.calls[0][2].signal as AbortSignal;
    expect(mocks.generateGuideHtml).toHaveBeenCalledWith(guideEntries, { title: '核准教學' }, { signal });
    expect(mocks.generateGuideMarkdown).toHaveBeenCalledWith(guideEntries, { title: '核准教學' }, { signal });
    expect(mocks.copyRichText).toHaveBeenCalledWith(
      '<!doctype html><main>核准教學</main>',
      '# 核准教學',
      signal,
    );
  });


  it('uses the same provider snapshot for both rich-text copy representations', async () => {
    const snapshotEntries = [{ kind: 'multiple' }] as unknown as readonly StepEntry[];
    const snapshotMetadata = { title: '原子複製教學' };
    const getGuideEntries = vi.fn().mockResolvedValue({ entries: snapshotEntries, metadata: snapshotMetadata });
    mocks.generateGuideHtml.mockResolvedValue('<!doctype html><main>原子複製教學</main>');
    mocks.generateGuideMarkdown.mockResolvedValue('# 原子複製教學');
    mocks.copyRichText.mockResolvedValue(undefined);
    render(
      <PublishGuideDialog
        open
        onOpenChange={vi.fn()}
        getGuideEntries={getGuideEntries}
        metadata={{ title: '過期的畫面標題' }}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /複製完整教學/ }));

    await waitFor(() => expect(mocks.copyRichText).toHaveBeenCalledOnce());
    const signal = getGuideEntries.mock.calls[0][0] as AbortSignal;
    expect(getGuideEntries).toHaveBeenCalledOnce();
    expect(mocks.generateGuideHtml).toHaveBeenCalledWith(snapshotEntries, snapshotMetadata, { signal });
    expect(mocks.generateGuideMarkdown).toHaveBeenCalledWith(snapshotEntries, snapshotMetadata, { signal });
  });

  it('opens about:blank before awaiting the entry snapshot, then loads generated print HTML', async () => {
    const order: string[] = [];
    let approve!: (snapshot: { entries: readonly StepEntry[]; metadata: { title: string } }) => void;
    const getGuideEntries = vi.fn((_signal: AbortSignal) => {
      order.push('entries');
      return new Promise<{ entries: readonly StepEntry[]; metadata: { title: string } }>((resolve) => { approve = resolve; });
    });
    const popup = { close: vi.fn() } as unknown as Window;
    mocks.openPrintPlaceholder.mockImplementation(() => {
      order.push('popup');
      return popup;
    });
    mocks.generatePrintReadyGuideHtml.mockResolvedValue('<!doctype html><title>列印</title>');
    mocks.loadHtmlIntoWindow.mockResolvedValue(undefined);
    render(
      <PublishGuideDialog
        open
        onOpenChange={vi.fn()}
        getGuideEntries={getGuideEntries}
        metadata={{ title: '過期的畫面標題' }}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /開啟列印版/ }));
    expect(order).toEqual(['popup', 'entries']);

    const snapshotEntries = [{ kind: 'multiple' }] as unknown as readonly StepEntry[];
    const snapshotMetadata = { title: '原子列印教學' };
    approve({ entries: snapshotEntries, metadata: snapshotMetadata });
    await waitFor(() => expect(mocks.loadHtmlIntoWindow).toHaveBeenCalledOnce());
    const signal = getGuideEntries.mock.calls[0][0] as AbortSignal;
    expect(getGuideEntries).toHaveBeenCalledOnce();
    expect(mocks.generatePrintReadyGuideHtml).toHaveBeenCalledWith(snapshotEntries, snapshotMetadata, { signal });
    expect(mocks.loadHtmlIntoWindow).toHaveBeenCalledWith(popup, '<!doctype html><title>列印</title>', signal);
    expect(popup.close).not.toHaveBeenCalled();
    expect((await screen.findByRole('status')).textContent).toContain('另存為 PDF');
  });

  it('closes the synchronously opened print window and exposes an error when generation fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const popup = { close: vi.fn() } as unknown as Window;
    mocks.openPrintPlaceholder.mockReturnValue(popup);
    mocks.generatePrintReadyGuideHtml.mockRejectedValue(new Error('redaction gate failed'));
    renderDialog();

    fireEvent.click(screen.getByRole('button', { name: /開啟列印版/ }));

    expect((await screen.findByRole('alert')).textContent).toContain('無法開啟列印版');
    expect(popup.close).toHaveBeenCalledOnce();
    expect(mocks.loadHtmlIntoWindow).not.toHaveBeenCalled();
  });

  it('shows a popup-blocker error without starting asynchronous generation', () => {
    mocks.openPrintPlaceholder.mockReturnValue(null);
    renderDialog();

    fireEvent.click(screen.getByRole('button', { name: /開啟列印版/ }));

    expect(screen.getByRole('alert').textContent).toContain('瀏覽器封鎖了列印視窗');
    expect(mocks.generatePrintReadyGuideHtml).not.toHaveBeenCalled();
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

    fireEvent.click(screen.getByRole('button', { name: /下載圖片 ZIP/ }));
    await waitFor(() => expect(onExportImages).toHaveBeenCalledOnce());
    fireEvent.click(screen.getByRole('button', { name: /取消下載圖片 ZIP/ }));

    await waitFor(() => expect(callbackSignal?.aborted).toBe(true));
    expect((await screen.findByRole('status')).textContent).toContain('已取消發佈操作。');
  });

  it('disables publication actions when the guide entry set is empty', () => {
    renderDialog({ guideEntries: [] });

    expect(screen.getByText('目前沒有可供發佈的步驟。')).toBeTruthy();
    expect((screen.getByRole('button', { name: /下載 Markdown/ }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: /複製完整教學/ }) as HTMLButtonElement).disabled).toBe(true);
  });
});
