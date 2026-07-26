import { useEffect, useRef, useState } from 'react';
import { Camera, Check, Copy, Loader2, Trash2 } from 'lucide-react';
import { compositeStepEntry } from '@/lib/export/entry-render';
import { getEntryPrivacyState, type StepEntry } from '@/lib/storage/db';
import { PRIVACY_REVIEW_REQUIRED_ACTION_BLOCKED } from '@/lib/editor/editor-messages';
import InlineAlert from '@/components/shared/InlineAlert';
import { reportError } from '@/components/shared/report-error';

interface Props {
  entry: StepEntry;
  onDelete: () => Promise<void>;
  onRecapture?: () => Promise<void>;
  deleteDisabled?: boolean;
  operationsDisabled?: boolean;
  recaptureDisabledReason?: string;
}

/** Composites the entry's highlight(s) onto its screenshot and writes the
 * result straight to the clipboard as PNG — same annotate pipeline the ZIP
 * export uses, just a different output format and destination. */
async function copyEntryImage(entry: StepEntry): Promise<void> {
  const blob = await compositeStepEntry(entry, 'image/png');
  await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
}

export default function StepActions({
  entry,
  onDelete,
  onRecapture,
  deleteDisabled = false,
  operationsDisabled = false,
  recaptureDisabledReason,
}: Props) {
  const [copying, setCopying] = useState(false);
  const [copied, setCopied] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [recapturing, setRecapturing] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const privacyReviewRequired = getEntryPrivacyState(entry).reviewRequired;
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (copiedTimer.current) clearTimeout(copiedTimer.current);
    },
    [],
  );

  async function handleCopy() {
    if (copying || operationsDisabled || privacyReviewRequired) {
      if (privacyReviewRequired) setActionError(PRIVACY_REVIEW_REQUIRED_ACTION_BLOCKED);
      return;
    }
    setCopying(true);
    setCopied(false);
    setActionError(null);
    try {
      await copyEntryImage(entry);
      setCopied(true);
      if (copiedTimer.current) clearTimeout(copiedTimer.current);
      copiedTimer.current = setTimeout(() => {
        setCopied(false);
        copiedTimer.current = null;
      }, 2_000);
    } catch (err) {
      setActionError(reportError('複製圖片到剪貼簿失敗', err, '複製失敗，請確認剪貼簿權限後再試一次。'));
    } finally {
      setCopying(false);
    }
  }

  async function handleRecapture() {
    if (!onRecapture || recapturing || operationsDisabled || recaptureDisabledReason) return;
    setRecapturing(true);
    setActionError(null);
    try {
      await onRecapture();
    } catch (err) {
      setActionError(reportError('啟動補拍失敗', err, '無法啟動補拍，請再試一次。'));
    } finally {
      setRecapturing(false);
    }
  }

  async function handleDelete() {
    if (deleting || deleteDisabled) return;
    setDeleting(true);
    setActionError(null);
    try {
      await onDelete();
    } catch (err) {
      setActionError(reportError('刪除步驟失敗', err, '刪除失敗，請再試一次。'));
    } finally {
      setDeleting(false);
    }
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex items-center gap-[3px]">
        <button
          type="button"
          onClick={handleCopy}
          disabled={operationsDisabled || privacyReviewRequired || copying || deleting || recapturing}
          title={privacyReviewRequired ? '請先重新確認敏感資訊遮罩' : '複製圖片'}
          aria-label="複製圖片"
          className="flex size-[34px] items-center justify-center rounded-md text-foreground/50 transition-colors hover:bg-foreground/6 hover:text-foreground dark:text-white/55 dark:hover:bg-white/8 dark:hover:text-white disabled:pointer-events-none disabled:opacity-40"
        >
          {copying ? <Loader2 className="size-[17px] animate-spin" /> : copied ? <Check className="size-[17px] text-brand" /> : <Copy className="size-[17px]" />}
        </button>
        <button
          type="button"
          onClick={() => void handleRecapture()}
          disabled={!onRecapture || operationsDisabled || recapturing || deleting || copying || Boolean(recaptureDisabledReason)}
          title={recaptureDisabledReason ?? (operationsDisabled ? '目前無法補拍步驟' : '重新拍攝')}
          aria-label="重新拍攝"
          className="flex size-[34px] items-center justify-center rounded-md text-foreground/50 transition-colors hover:bg-foreground/6 hover:text-foreground dark:text-white/55 dark:hover:bg-white/8 dark:hover:text-white disabled:pointer-events-none disabled:opacity-40"
        >
          {recapturing ? <Loader2 className="size-[17px] animate-spin" /> : <Camera className="size-[17px]" />}
        </button>
        <span className="mx-[3px] h-[20px] w-[1px] bg-border" aria-hidden="true" />
        <button
          type="button"
          onClick={handleDelete}
          disabled={deleteDisabled || operationsDisabled || deleting || copying || recapturing}
          title={deleteDisabled ? '錄製或補拍期間無法刪除步驟' : '刪除'}
          aria-label="刪除步驟"
          className="flex size-[34px] items-center justify-center rounded-md text-foreground/50 transition-colors hover:bg-danger-soft hover:text-danger disabled:pointer-events-none disabled:opacity-40"
        >
          {deleting ? <Loader2 className="size-[17px] animate-spin" /> : <Trash2 className="size-[17px]" />}
        </button>
      </div>
      {actionError && <InlineAlert>{actionError}</InlineAlert>}
    </div>
  );
}
