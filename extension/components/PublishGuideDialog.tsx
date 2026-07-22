import { useEffect, useId, useRef, useState } from 'react';
import { Clipboard, Download, FileCode2, FileText, Images, Loader2, Printer, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  generateGuideHtml,
  generateGuideMarkdown,
  generatePrintReadyGuideHtml,
  guideExportFilename,
  type GuideExportMetadata,
} from '@/lib/guide-export';
import type { StepEntry } from '@/lib/db';
import {
  copyRichText,
  downloadText,
  loadHtmlIntoWindow,
  openPrintPlaceholder,
  throwIfDownloadAborted,
} from '@/lib/download-utils';

export type ApprovedGuideEntriesSnapshot = {
  /** Entries accepted by one publication quality-gate run. */
  entries: readonly StepEntry[];
  /** Metadata captured by that same quality-gate run. */
  metadata?: GuideExportMetadata;
};

/**
 * May return legacy entries alone, or an atomic publication snapshot when the
 * quality gate also owns metadata that must stay paired with those entries.
 */
export type ApprovedGuideEntriesProvider = (
  signal: AbortSignal,
) =>
  | readonly StepEntry[]
  | ApprovedGuideEntriesSnapshot
  | Promise<readonly StepEntry[] | ApprovedGuideEntriesSnapshot>;

type ApprovedEntriesSource =
  | {
      /** Entries already accepted by the editor's publication quality gate. */
      approvedEntries: readonly StepEntry[];
      getApprovedEntries?: never;
    }
  | {
      approvedEntries?: never;
      /** Flushes edits/runs the quality gate, then returns only approved entries. */
      getApprovedEntries: ApprovedGuideEntriesProvider;
    };

export type PublishGuideDialogProps = ApprovedEntriesSource & {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  metadata?: GuideExportMetadata;
  /** Optional bridge to the existing annotated-images ZIP export. */
  onExportImages?: (signal: AbortSignal) => void | Promise<void>;
};

type PublicationAction = 'markdown' | 'html' | 'print' | 'copy' | 'images';

const ACTION_LABELS: Readonly<Record<PublicationAction, string>> = {
  markdown: '下載 Markdown',
  html: '下載自包含 HTML',
  print: '開啟列印版',
  copy: '複製完整教學',
  images: '下載圖片 ZIP',
};

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

function isApprovedGuideEntriesSnapshot(
  value: readonly StepEntry[] | ApprovedGuideEntriesSnapshot,
): value is ApprovedGuideEntriesSnapshot {
  return !Array.isArray(value);
}

export default function PublishGuideDialog(props: PublishGuideDialogProps) {
  const { open, onOpenChange, metadata = {}, onExportImages } = props;
  const [pendingAction, setPendingAction] = useState<PublicationAction | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const activeController = useRef<AbortController | null>(null);
  const messageId = useId();
  const busy = pendingAction !== null;
  const knownEmpty = props.approvedEntries?.length === 0;

  useEffect(() => () => activeController.current?.abort(), []);

  function requestOpenChange(nextOpen: boolean) {
    if (!nextOpen) activeController.current?.abort();
    onOpenChange(nextOpen);
  }

  async function resolveApprovedEntries(signal: AbortSignal): Promise<ApprovedGuideEntriesSnapshot> {
    const result = props.getApprovedEntries
      ? await props.getApprovedEntries(signal)
      : { entries: props.approvedEntries, metadata };
    throwIfDownloadAborted(signal);

    const snapshot = isApprovedGuideEntriesSnapshot(result)
      ? { entries: result.entries, metadata: result.metadata ?? metadata }
      : { entries: result, metadata };
    if (snapshot.entries.length === 0) throw new Error('No approved guide entries are available.');
    return snapshot;
  }

  async function runAction(
    action: PublicationAction,
    task: (signal: AbortSignal) => Promise<void>,
    successMessage: string,
    popupToCloseOnFailure?: Window,
  ) {
    if (activeController.current) {
      popupToCloseOnFailure?.close();
      return;
    }

    const controller = new AbortController();
    activeController.current = controller;
    setPendingAction(action);
    setError(null);
    setNotice(null);

    try {
      await task(controller.signal);
      throwIfDownloadAborted(controller.signal);
      setNotice(successMessage);
    } catch (actionError) {
      popupToCloseOnFailure?.close();
      if (isAbortError(actionError) || controller.signal.aborted) {
        setNotice('已取消發佈操作。');
      } else {
        console.error(`教學發佈失敗：${action}`, actionError);
        setError(
          action === 'print'
            ? '無法開啟列印版。請允許彈出式視窗、確認遮罩後再試一次。'
            : '無法完成發佈。請確認所有敏感資訊遮罩與教學內容後再試一次。',
        );
      }
    } finally {
      if (activeController.current === controller) activeController.current = null;
      setPendingAction(null);
    }
  }

  function downloadMarkdown() {
    void runAction(
      'markdown',
      async (signal) => {
        const snapshot = await resolveApprovedEntries(signal);
        const markdown = await generateGuideMarkdown(snapshot.entries, snapshot.metadata, { signal });
        throwIfDownloadAborted(signal);
        await downloadText(markdown, guideExportFilename(snapshot.metadata, 'markdown'), 'text/markdown;charset=utf-8', { signal });
      },
      'Markdown 已開始下載。',
    );
  }

  function downloadHtml() {
    void runAction(
      'html',
      async (signal) => {
        const snapshot = await resolveApprovedEntries(signal);
        const html = await generateGuideHtml(snapshot.entries, snapshot.metadata, { signal });
        throwIfDownloadAborted(signal);
        await downloadText(html, guideExportFilename(snapshot.metadata, 'html'), 'text/html;charset=utf-8', { signal });
      },
      '自包含 HTML 已開始下載。',
    );
  }

  function openPrintVersion() {
    // Keep this before every await (including the quality-gate callback).
    const printWindow = openPrintPlaceholder();
    if (!printWindow) {
      setNotice(null);
      setError('瀏覽器封鎖了列印視窗。請允許彈出式視窗後再試一次。');
      return;
    }

    void runAction(
      'print',
      async (signal) => {
        const snapshot = await resolveApprovedEntries(signal);
        const html = await generatePrintReadyGuideHtml(snapshot.entries, snapshot.metadata, { signal });
        throwIfDownloadAborted(signal);
        await loadHtmlIntoWindow(printWindow, html, signal);
      },
      '列印版已開啟；請在新分頁選擇「列印」→「另存為 PDF」。',
      printWindow,
    );
  }

  function copyGuide() {
    void runAction(
      'copy',
      async (signal) => {
        const snapshot = await resolveApprovedEntries(signal);
        // Both representations go through the fail-closed publication
        // generators; callers cannot supply pre-rendered, unredacted markup.
        const html = await generateGuideHtml(snapshot.entries, snapshot.metadata, { signal });
        throwIfDownloadAborted(signal);
        const plainText = await generateGuideMarkdown(snapshot.entries, snapshot.metadata, { signal });
        throwIfDownloadAborted(signal);
        await copyRichText(html, plainText, signal);
      },
      '已複製完整教學（HTML 與純文字）。',
    );
  }

  function exportImages() {
    if (!onExportImages) return;
    void runAction(
      'images',
      async (signal) => {
        await onExportImages(signal);
        throwIfDownloadAborted(signal);
      },
      '圖片 ZIP 已開始下載。',
    );
  }

  function cancelAction() {
    activeController.current?.abort();
  }

  const actionButton = (
    action: PublicationAction,
    label: string,
    description: string,
    Icon: typeof Download,
    onClick: () => void,
  ) => (
    <button
      type="button"
      disabled={busy || knownEmpty}
      aria-describedby={`${messageId}-${action}`}
      onClick={onClick}
      className="flex min-h-24 w-full items-start gap-3 rounded-lg border border-stone-200 bg-white p-4 text-left transition-colors hover:border-lime-600 hover:bg-lime-50 focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-lime-600/40 disabled:cursor-not-allowed disabled:opacity-50 dark:border-stone-700 dark:bg-stone-900 dark:hover:border-lime-400 dark:hover:bg-lime-950/30"
    >
      <span className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-full bg-lime-100 text-lime-800 dark:bg-lime-950 dark:text-lime-300" aria-hidden="true">
        {pendingAction === action ? <Loader2 className="size-4 animate-spin" /> : <Icon className="size-4" />}
      </span>
      <span className="min-w-0">
        <span className="block text-sm font-semibold text-stone-900 dark:text-stone-100">{label}</span>
        <span id={`${messageId}-${action}`} className="mt-1 block text-xs leading-5 text-stone-600 dark:text-stone-300">
          {description}
        </span>
      </span>
    </button>
  );

  return (
    <Dialog open={open} onOpenChange={requestOpenChange}>
      <DialogContent
        showClose={!busy}
        aria-describedby={`${messageId}-description`}
        className="max-h-[min(760px,calc(100vh-32px))] w-[min(680px,calc(100vw-32px))] overflow-y-auto border border-stone-200 bg-stone-50 p-0 text-stone-900 dark:border-stone-700 dark:bg-stone-950 dark:text-stone-100"
      >
        <DialogHeader className="border-b border-stone-200 bg-white px-6 py-5 dark:border-stone-700 dark:bg-stone-900">
          <DialogTitle className="text-lg">發佈教學</DialogTitle>
          <DialogDescription id={`${messageId}-description`} className="leading-6 text-stone-600 dark:text-stone-300">
            下載可攜格式、複製完整內容，或開啟列印版後使用「列印」→「另存為 PDF」。所有圖片都會經過既有的標註與遮罩產生器。
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 px-6 py-5">
          {knownEmpty && (
            <p role="status" className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
              目前沒有通過品質檢查、可供發佈的步驟。
            </p>
          )}

          <section aria-labelledby={`${messageId}-files-title`} className="space-y-3">
            <h2 id={`${messageId}-files-title`} className="text-sm font-semibold">下載與列印</h2>
            <div className="grid gap-3 sm:grid-cols-2">
              {actionButton('markdown', ACTION_LABELS.markdown, '適合版本控制與文字編輯；圖片直接內嵌。', FileText, downloadMarkdown)}
              {actionButton('html', ACTION_LABELS.html, '單一離線檔案，包含樣式與所有圖片。', FileCode2, downloadHtml)}
              {actionButton('print', ACTION_LABELS.print, '同步開啟新分頁，再產生適合列印的版本。', Printer, openPrintVersion)}
              {onExportImages && actionButton('images', ACTION_LABELS.images, '保留既有的已標註圖片 ZIP 工作流程。', Images, exportImages)}
            </div>
          </section>

          <section aria-labelledby={`${messageId}-copy-title`} className="space-y-3">
            <h2 id={`${messageId}-copy-title`} className="text-sm font-semibold">複製到剪貼簿</h2>
            {actionButton('copy', ACTION_LABELS.copy, '同一個 ClipboardItem 同時提供 text/html 與 text/plain。', Clipboard, copyGuide)}
          </section>

          <div aria-live="polite" aria-atomic="true">
            {error && (
              <p role="alert" className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-800 dark:border-rose-900 dark:bg-rose-950/40 dark:text-rose-200">
                {error}
              </p>
            )}
            {!error && notice && (
              <p role="status" className="rounded-md border border-lime-200 bg-lime-50 px-3 py-2 text-sm text-lime-900 dark:border-lime-900 dark:bg-lime-950/40 dark:text-lime-200">
                {notice}
              </p>
            )}
          </div>
        </div>

        <DialogFooter className="border-t border-stone-200 bg-white px-6 py-4 dark:border-stone-700 dark:bg-stone-900">
          {busy ? (
            <Button type="button" variant="outline" onClick={cancelAction}>
              <X />取消{ACTION_LABELS[pendingAction]}
            </Button>
          ) : (
            <Button type="button" variant="outline" onClick={() => requestOpenChange(false)}>
              關閉
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
