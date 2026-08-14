import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Download, Image as ImageIcon, Loader2, X } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  generateGuideHtml,
  generateGuideMarkdownArchive,
  generateGuidePdf,
  guideExportFilename,
  type GuideExportMetadata,
} from '@/lib/export/guide-export';
import type { StepEntry } from '@/lib/storage/db';
import { downloadBlobViaBrowser } from '@/lib/export/download-utils';
import InlineAlert from '@/components/shared/InlineAlert';
import { UNTITLED_GUIDE_TITLE } from '@/lib/editor/editor-messages';
import { isAbortError, throwIfAborted } from '@/lib/shared/abort';

export type GuideEntriesSnapshot = {
  entries: readonly StepEntry[];
  metadata?: GuideExportMetadata;
};

export type GuideEntriesProvider = (
  signal: AbortSignal,
) =>
  | readonly StepEntry[]
  | GuideEntriesSnapshot
  | Promise<readonly StepEntry[] | GuideEntriesSnapshot>;

export type PublishGuideDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Resolves the entries (and optionally fresher metadata) to publish. */
  getGuideEntries: GuideEntriesProvider;
  metadata?: GuideExportMetadata;
  onExportImages?: (signal: AbortSignal) => void | Promise<void>;
};

type DownloadPublicationAction = Extract<PublicationAction, 'markdown' | 'html' | 'pdf'>;
type PublicationAction = 'markdown' | 'html' | 'pdf' | 'images';

const ACTION_ERROR_MESSAGES: Readonly<Record<PublicationAction, string>> = {
  markdown: '無法下載 Markdown。請確認所有敏感資訊遮罩與內容後再試一次。',
  html: '無法下載 HTML 網頁。請確認所有敏感資訊遮罩與內容後再試一次。',
  pdf: '無法下載 PDF。請確認所有敏感資訊遮罩與內容後再試一次。',
  images: '無法下載圖片。請確認所有敏感資訊遮罩後再試一次。',
};

const DOWNLOAD_SUCCESS_MESSAGES: Readonly<Record<DownloadPublicationAction, string>> = {
  markdown: 'Markdown ZIP 已開始下載。',
  html: 'HTML 網頁已開始下載。',
  pdf: 'PDF 已開始下載。',
};

type PublicationOption = {
  action: PublicationAction;
  title: string;
  ariaLabel: string;
  description: string;
  icon: ReactNode;
  disabled: boolean;
  onSelect: () => void;
};

function MonoGlyph({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <span className={`rounded-md border border-foreground/70 py-0.5 font-mono font-bold leading-none ${className}`}>
      {children}
    </span>
  );
}

function PublicationOptionCard({ option, pending }: { option: PublicationOption; pending: boolean }) {
  return (
    <button
      type="button"
      aria-label={option.ariaLabel}
      disabled={option.disabled}
      onClick={option.onSelect}
      className="group flex items-center justify-between rounded-md border border-border bg-surface-raised p-4 text-left transition-all hover:border-foreground/25 hover:bg-secondary disabled:pointer-events-none disabled:opacity-40"
    >
      <div className="flex min-w-0 items-center gap-4">
        <div className="flex size-12 shrink-0 items-center justify-center rounded-md bg-secondary text-foreground">
          {option.icon}
        </div>
        <div className="min-w-0">
          <div className="text-[15px] font-bold text-foreground">{option.title}</div>
          <div className="mt-0.5 break-words text-[12.5px] font-normal text-muted-foreground">
            {option.description}
          </div>
        </div>
      </div>
      {pending ? (
        <Loader2 className="size-5 shrink-0 animate-spin text-muted-foreground" />
      ) : (
        <Download className="size-5 shrink-0 text-muted-foreground/60 transition-colors group-hover:text-foreground" />
      )}
    </button>
  );
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
  const busy = pendingAction !== null;

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
    const result = await props.getGuideEntries(signal);
    throwIfAborted(signal);

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
  ) {
    if (activeController.current) return;

    const controller = new AbortController();
    activeController.current = controller;
    setPendingAction(action);
    setError(null);
    setNotice(null);

    try {
      await task(controller.signal);
      throwIfAborted(controller.signal);
      setNotice(successMessage);
    } catch (actionError) {
      if (isAbortError(actionError) || controller.signal.aborted) {
        setNotice('已取消匯出操作。');
      } else {
        console.error(`內容匯出失敗：${action}`, actionError);
        setError(ACTION_ERROR_MESSAGES[action]);
      }
    } finally {
      if (activeController.current === controller) activeController.current = null;
      setPendingAction(null);
    }
  }

  function downloadGuide(action: DownloadPublicationAction) {
    void runAction(
      action,
      async (signal) => {
        const snapshot = await resolveGuideEntries(signal);
        switch (action) {
          // downloadBlobViaBrowser resolves only after the browser has queued
          // the transfer, and the transfer itself survives this page closing,
          // so the success notice below cannot report a download that never
          // reached the browser.
          case 'markdown': {
            const archive = await generateGuideMarkdownArchive(snapshot.entries, snapshot.metadata, { signal });
            throwIfAborted(signal);
            await downloadBlobViaBrowser(
              archive.blob,
              guideExportFilename(snapshot.metadata, 'markdown-archive'),
              { signal },
            );
            return;
          }

          case 'html': {
            const html = await generateGuideHtml(snapshot.entries, snapshot.metadata, { signal });
            throwIfAborted(signal);
            await downloadBlobViaBrowser(
              new Blob([html], { type: 'text/html;charset=utf-8' }),
              guideExportFilename(snapshot.metadata, 'html'),
              { signal },
            );
            return;
          }

          case 'pdf': {
            const pdf = await generateGuidePdf(snapshot.entries, snapshot.metadata, { signal });
            throwIfAborted(signal);
            await downloadBlobViaBrowser(pdf, guideExportFilename(snapshot.metadata, 'pdf'), { signal });
            return;
          }
        }
      },
      DOWNLOAD_SUCCESS_MESSAGES[action],
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

  const titleText = metadata.title?.trim() || UNTITLED_GUIDE_TITLE;
  const publicationOptions: readonly PublicationOption[] = [
    {
      action: 'markdown',
      title: 'Markdown',
      ariaLabel: '下載 Markdown',
      description: '純文字步驟與說明，適合貼進文件',
      icon: <MonoGlyph className="px-1 text-[10.5px]">M↓</MonoGlyph>,
      disabled: busy,
      onSelect: () => downloadGuide('markdown'),
    },
    {
      action: 'pdf',
      title: 'PDF',
      ariaLabel: '下載 PDF',
      description: '排版好的操作文件，可直接列印分享',
      icon: <MonoGlyph className="px-1.5 text-[11px]">P</MonoGlyph>,
      disabled: busy,
      onSelect: () => downloadGuide('pdf'),
    },
    {
      action: 'images',
      title: '圖片',
      ariaLabel: '下載圖片',
      description: '每個步驟的截圖，打包成 ZIP 下載',
      icon: <ImageIcon className="size-5 text-foreground" />,
      disabled: busy || !onExportImages,
      onSelect: exportImages,
    },
    {
      action: 'html',
      title: 'HTML 網頁',
      ariaLabel: '下載 HTML 網頁',
      description: '單一檔案內含所有截圖，最適合直接分享',
      icon: <MonoGlyph className="px-1 text-[10.5px]">&lt;/&gt;</MonoGlyph>,
      disabled: busy,
      onSelect: () => downloadGuide('html'),
    },
  ];

  return (
    <Dialog open={open} onOpenChange={requestOpenChange}>
      <DialogContent
        showClose={false}
        className="app-scrollbar max-h-[calc(100vh-32px)] w-[92vw] max-w-[480px] overflow-y-auto rounded-md border border-border bg-card p-6 text-foreground shadow-[var(--shadow-dialog)] focus:outline-none"
      >
        {/* Header */}
        <div className="flex items-start gap-3 pb-2">
          <div className="min-w-0 flex-1">
            <DialogTitle className="text-xl font-bold text-foreground">匯出</DialogTitle>
            <DialogDescription className="mt-1 break-words text-[13.5px] font-normal text-muted-foreground">
              「{titleText}」
            </DialogDescription>
          </div>
          <button
            type="button"
            onClick={() => requestOpenChange(false)}
            aria-label="關閉"
            className="flex size-8 shrink-0 items-center justify-center rounded-full bg-foreground/5 text-muted-foreground transition-colors hover:bg-foreground/10 hover:text-foreground"
          >
            <X className="size-4" />
          </button>
        </div>

        {/* Options List */}
        <div className="mt-4 flex flex-col gap-3">
          {publicationOptions.map((option) => (
            <PublicationOptionCard
              key={option.action}
              option={option}
              pending={pendingAction === option.action}
            />
          ))}
        </div>

        {/* Notices */}
        <div aria-live="polite" aria-atomic="true" className="mt-1">
          {error && <InlineAlert>{error}</InlineAlert>}
          {!error && notice && (
            <p role="status" className="rounded-md border border-brand/30 bg-brand/10 px-4 py-2.5 text-xs text-foreground">
              {notice}
            </p>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
