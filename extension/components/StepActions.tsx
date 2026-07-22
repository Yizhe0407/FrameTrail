import { useEffect, useRef, useState } from 'react';
import { Camera, Check, Copy, Loader2, MoreHorizontal, Trash2 } from 'lucide-react';
import { compositeStepEntry } from '@/lib/entry-render';
import { getEntryPrivacyState, type StepEntry } from '@/lib/db';

interface Props {
  entry: StepEntry;
  onDelete: () => Promise<void>;
  onRecapture?: () => Promise<void>;
  deleteDisabled?: boolean;
  operationsDisabled?: boolean;
  recaptureDisabledReason?: string;
}

const BUTTON_CLASS =
  'flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm text-stone-700 transition-colors hover:bg-stone-100 disabled:cursor-not-allowed disabled:opacity-40 dark:text-stone-200 dark:hover:bg-stone-800';

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
      if (privacyReviewRequired) setActionError('請先開啟「調整圖片」重新確認敏感資訊遮罩。');
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
      console.error('複製圖片到剪貼簿失敗', err);
      setActionError('複製失敗，請確認剪貼簿權限後再試一次。');
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
      console.error('啟動補拍失敗', err);
      setActionError(err instanceof Error ? err.message : '無法啟動補拍，請再試一次。');
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
      console.error('刪除步驟失敗', err);
      setActionError('刪除失敗，請再試一次。');
    } finally {
      setDeleting(false);
    }
  }

  return (
    <div className="relative flex flex-col items-end gap-1">
      <details className="group relative">
        <summary
          aria-label="更多步驟操作"
          title="更多步驟操作"
          className="flex size-10 list-none items-center justify-center rounded-md text-stone-500 outline-none hover:bg-stone-200 hover:text-stone-800 focus-visible:ring-2 focus-visible:ring-blue-600 [&::-webkit-details-marker]:hidden dark:text-stone-400 dark:hover:bg-stone-700 dark:hover:text-stone-100"
        >
          <MoreHorizontal className="size-4" aria-hidden="true" />
        </summary>
        <div className="absolute top-10 right-0 z-20 w-48 rounded-lg border border-stone-200 bg-white p-1.5 shadow-lg dark:border-stone-700 dark:bg-stone-900">
          <button
            type="button"
            onClick={handleCopy}
            disabled={operationsDisabled || privacyReviewRequired || copying || deleting || recapturing}
            title={privacyReviewRequired ? '請先重新確認敏感資訊遮罩' : '複製已套用遮罩的圖片'}
            className={BUTTON_CLASS}
          >
            {copying ? <Loader2 className="size-4 animate-spin" /> : copied ? <Check className="size-4 text-lime-700 dark:text-lime-400" /> : <Copy className="size-4" />}
            <span aria-live="polite">{copying ? '複製中' : copied ? '已複製' : '複製圖片'}</span>
          </button>
          <button
            type="button"
            onClick={() => void handleRecapture()}
            disabled={!onRecapture || operationsDisabled || recapturing || deleting || copying || Boolean(recaptureDisabledReason)}
            title={recaptureDisabledReason ?? (operationsDisabled ? '目前無法補拍步驟' : '回到來源頁面重新框選並拍攝')}
            className={BUTTON_CLASS}
          >
            {recapturing ? <Loader2 className="size-4 animate-spin" /> : <Camera className="size-4" />}
            {recapturing ? '準備中' : '重新拍攝'}
          </button>
          <div className="my-1 border-t border-stone-200 dark:border-stone-700" />
          <button
            type="button"
            onClick={handleDelete}
            disabled={deleteDisabled || operationsDisabled || deleting || copying || recapturing}
            title={deleteDisabled ? '錄製或補拍期間無法刪除步驟' : '刪除步驟'}
            className={`${BUTTON_CLASS} text-red-700 hover:bg-red-50 dark:text-red-300 dark:hover:bg-red-950/30`}
          >
            {deleting ? <Loader2 className="size-4 animate-spin" /> : <Trash2 className="size-4" />}
            {deleting ? '刪除中' : '刪除步驟'}
          </button>
        </div>
      </details>
      {actionError && <span role="alert" className="max-w-64 text-right text-xs text-red-600 dark:text-red-400">{actionError}</span>}
    </div>
  );
}
