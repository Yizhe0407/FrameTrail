import { useEffect, useId, useRef, useState } from 'react';
import { Download, ShieldCheck, Sparkles, X } from 'lucide-react';
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
} from '@/lib/export/guide-export';
import type { StepEntry } from '@/lib/storage/db';
import {
  copyRichText,
  downloadText,
  loadHtmlIntoWindow,
  openPrintPlaceholder,
  throwIfDownloadAborted,
} from '@/lib/export/download-utils';
import PublicationActionButton, {
  PUBLICATION_ACTION_CONTENT,
  type ActionPresentation,
  type PublicationAction,
} from './PublicationActionButton';

export type GuideEntriesSnapshot = {
  /** Entries captured for one publication action. */
  entries: readonly StepEntry[];
  /** Metadata captured with those entries. */
  metadata?: GuideExportMetadata;
};

/**
 * May return entries alone, or an atomic publication snapshot that keeps
 * metadata paired with the entries used for the action.
 */
export type GuideEntriesProvider = (
  signal: AbortSignal,
) =>
  | readonly StepEntry[]
  | GuideEntriesSnapshot
  | Promise<readonly StepEntry[] | GuideEntriesSnapshot>;

type GuideEntriesSource =
  | {
      /** Entries supplied directly to the dialog. */
      guideEntries: readonly StepEntry[];
      getGuideEntries?: never;
    }
  | {
      guideEntries?: never;
      /** Flushes pending edits, then returns the current guide entries. */
      getGuideEntries: GuideEntriesProvider;
    };

export type PublishGuideDialogProps = GuideEntriesSource & {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  metadata?: GuideExportMetadata;
  /** Optional bridge to the existing annotated-images ZIP export. */
  onExportImages?: (signal: AbortSignal) => void | Promise<void>;
};

type DownloadPublicationAction = Extract<PublicationAction, 'markdown' | 'html'>;

const DOWNLOAD_ACTIONS = {
  markdown: {
    generate: generateGuideMarkdown,
    filenameFormat: 'markdown' as const,
    mimeType: 'text/markdown;charset=utf-8',
    successMessage: 'Markdown 已開始下載。',
  },
  html: {
    generate: generateGuideHtml,
    filenameFormat: 'html' as const,
    mimeType: 'text/html;charset=utf-8',
    successMessage: '自包含 HTML 已開始下載。',
  },
} satisfies Readonly<Record<DownloadPublicationAction, {
  generate: typeof generateGuideMarkdown;
  filenameFormat: 'markdown' | 'html';
  mimeType: string;
  successMessage: string;
}>>;

const ACTION_ERROR_MESSAGES: Readonly<Record<PublicationAction, string>> = {
  markdown: '無法下載 Markdown。請確認所有敏感資訊遮罩與教學內容後再試一次。',
  html: '無法下載 HTML。請確認所有敏感資訊遮罩與教學內容後再試一次。',
  print: '無法開啟列印版。請允許彈出式視窗、確認遮罩後再試一次。',
  copy: '無法複製完整教學。請確認剪貼簿權限後再試一次。',
  images: '無法下載圖片 ZIP。請確認所有敏感資訊遮罩後再試一次。',
};

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

function isGuideEntriesSnapshot(
  value: readonly StepEntry[] | GuideEntriesSnapshot,
): value is GuideEntriesSnapshot {
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
  const knownEmpty = props.guideEntries?.length === 0;

  useEffect(() => () => activeController.current?.abort(), []);
  useEffect(() => {
    if (open) {
      setError(null);
      setNotice(null);
    }
  }, [open]);

  function requestOpenChange(nextOpen: boolean) {
    if (!nextOpen) activeController.current?.abort();
    onOpenChange(nextOpen);
  }

  async function resolveGuideEntries(signal: AbortSignal): Promise<GuideEntriesSnapshot> {
    const result = props.getGuideEntries
      ? await props.getGuideEntries(signal)
      : { entries: props.guideEntries, metadata };
    throwIfDownloadAborted(signal);

    const snapshot = isGuideEntriesSnapshot(result)
      ? { entries: result.entries, metadata: result.metadata ?? metadata }
      : { entries: result, metadata };
    if (snapshot.entries.length === 0) throw new Error('No guide entries are available.');
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
        setError(ACTION_ERROR_MESSAGES[action]);
      }
    } finally {
      if (activeController.current === controller) activeController.current = null;
      setPendingAction(null);
    }
  }

  function downloadGuide(action: DownloadPublicationAction) {
    const config = DOWNLOAD_ACTIONS[action];
    void runAction(
      action,
      async (signal) => {
        const snapshot = await resolveGuideEntries(signal);
        const output = await config.generate(snapshot.entries, snapshot.metadata, { signal });
        throwIfDownloadAborted(signal);
        await downloadText(
          output,
          guideExportFilename(snapshot.metadata, config.filenameFormat),
          config.mimeType,
          { signal },
        );
      },
      config.successMessage,
    );
  }

  function openPrintVersion() {
    // Keep this before every await, including the entry snapshot callback.
    const printWindow = openPrintPlaceholder();
    if (!printWindow) {
      setNotice(null);
      setError('瀏覽器封鎖了列印視窗。請允許彈出式視窗後再試一次。');
      return;
    }

    void runAction(
      'print',
      async (signal) => {
        const snapshot = await resolveGuideEntries(signal);
        const html = await generatePrintReadyGuideHtml(snapshot.entries, snapshot.metadata, { signal });
        throwIfDownloadAborted(signal);
        await loadHtmlIntoWindow(printWindow, html, signal);
        printWindow.focus?.();
      },
      '列印版已開啟；請在新分頁按 Ctrl / ⌘ + P 列印或另存為 PDF。',
      printWindow,
    );
  }

  function copyGuide() {
    void runAction(
      'copy',
      async (signal) => {
        const snapshot = await resolveGuideEntries(signal);
        // Both representations go through the fail-closed publication
        // generators; callers cannot supply pre-rendered, unredacted markup.
        const html = await generateGuideHtml(snapshot.entries, snapshot.metadata, { signal });
        throwIfDownloadAborted(signal);
        const plainText = await generateGuideMarkdown(snapshot.entries, snapshot.metadata, { signal });
        throwIfDownloadAborted(signal);
        await copyRichText(html, plainText, signal);
      },
      '完整教學已複製，可貼到支援富文字的編輯器。',
    );
  }

  function exportImages() {
    if (!onExportImages) return;
    void runAction(
      'images',
      async (signal) => {
        await onExportImages(signal);
      },
      '圖片 ZIP 已開始下載。',
    );
  }

  function cancelAction() {
    activeController.current?.abort();
  }

  const actionButton = (action: PublicationAction, presentation: ActionPresentation, onClick: () => void) => (
    <PublicationActionButton
      action={action}
      presentation={presentation}
      busy={busy}
      disabled={knownEmpty}
      pendingAction={pendingAction}
      descriptionId={`${messageId}-${action}`}
      onClick={onClick}
    />
  );

  return (
    <Dialog open={open} onOpenChange={requestOpenChange}>
      <DialogContent
        showClose={!busy}
        aria-describedby={`${messageId}-description`}
        className="app-scrollbar max-h-[min(820px,calc(100vh-28px))] w-[min(760px,calc(100vw-28px))] overflow-y-auto border border-stone-200 bg-stone-50 p-0 text-stone-900 shadow-2xl dark:border-stone-700 dark:bg-stone-950 dark:text-stone-100"
      >
        <DialogHeader className="border-b border-stone-200 bg-white px-6 py-5 pr-16 sm:px-7 dark:border-stone-700 dark:bg-stone-900">
          <div className="flex items-start gap-3">
            <span className="mt-0.5 flex size-10 shrink-0 items-center justify-center rounded-lg bg-lime-100 text-lime-800 dark:bg-lime-950 dark:text-lime-300" aria-hidden="true">
              <Download className="size-4" />
            </span>
            <div className="min-w-0">
              <DialogTitle className="text-lg">發佈教學</DialogTitle>
              <DialogDescription id={`${messageId}-description`} className="mt-1 max-w-2xl leading-6 text-stone-600 dark:text-stone-300">
                選擇最適合的輸出方式。所有圖片都會先套用既有標註與敏感資訊遮罩，再於本機產生檔案。
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        <div className="space-y-6 px-6 py-6 sm:px-7">
          {knownEmpty && (
            <p role="status" className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
              目前沒有可供發佈的步驟。
            </p>
          )}

          <section aria-labelledby={`${messageId}-recommended-title`} className="space-y-3">
            <div className="flex items-center gap-2">
              <Sparkles className="size-4 text-lime-700 dark:text-lime-400" aria-hidden="true" />
              <h2 id={`${messageId}-recommended-title`} className="text-sm font-semibold">推薦格式</h2>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              {actionButton('html', 'featured', () => downloadGuide('html'))}
              {actionButton('print', 'featured', openPrintVersion)}
            </div>
          </section>

          <section aria-labelledby={`${messageId}-more-title`} className="space-y-3">
            <div>
              <h2 id={`${messageId}-more-title`} className="text-sm font-semibold">其他下載方式</h2>
              <p className="mt-1 text-xs text-stone-500 dark:text-stone-400">需要再編輯內容或取得個別圖片時使用。</p>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              {actionButton('markdown', 'compact', () => downloadGuide('markdown'))}
              {onExportImages && actionButton('images', 'compact', exportImages)}
            </div>
          </section>

          <section aria-labelledby={`${messageId}-copy-title`} className="space-y-3">
            <div>
              <h2 id={`${messageId}-copy-title`} className="text-sm font-semibold">快速複製</h2>
              <p className="mt-1 text-xs text-stone-500 dark:text-stone-400">不用建立檔案，直接貼到支援富文字的工具。</p>
            </div>
            {actionButton('copy', 'compact', copyGuide)}
          </section>

          <div aria-live="polite" aria-atomic="true">
            {error && (
              <p role="alert" className="rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800 dark:border-rose-900 dark:bg-rose-950/40 dark:text-rose-200">
                {error}
              </p>
            )}
            {!error && notice && (
              <p role="status" className="rounded-lg border border-lime-200 bg-lime-50 px-4 py-3 text-sm text-lime-900 dark:border-lime-900 dark:bg-lime-950/40 dark:text-lime-200">
                {notice}
              </p>
            )}
          </div>
        </div>

        <DialogFooter className="flex-col-reverse items-stretch justify-between border-t border-stone-200 bg-white px-6 py-4 sm:flex-row sm:items-center sm:px-7 dark:border-stone-700 dark:bg-stone-900">
          <p className="flex items-center gap-2 text-xs text-stone-500 dark:text-stone-400">
            <ShieldCheck className="size-4 text-lime-700 dark:text-lime-400" aria-hidden="true" />
            檔案僅在此裝置上產生
          </p>
          {busy ? (
            <Button type="button" variant="outline" onClick={cancelAction}>
              <X />取消{PUBLICATION_ACTION_CONTENT[pendingAction].label}
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
