import { useEffect, useRef, useState } from 'react';
import { Camera, Check, Copy, Loader2, Trash2 } from 'lucide-react';
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
  'flex items-center gap-1.5 rounded-lg px-2.5 py-2 text-xs text-stone-400 transition-colors dark:text-stone-500';

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
      if (privacyReviewRequired) setActionError('請先開啟「修正／遮罩」重新確認敏感資訊遮罩。');
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
    <div className="flex flex-col items-end gap-1">
      <div className="flex items-center gap-0.5">
        <button
          type="button"
          onClick={handleCopy}
          onPointerDown={(event) => event.preventDefault()}
          disabled={operationsDisabled || privacyReviewRequired || copying || deleting || recapturing}
          title={privacyReviewRequired ? '請先重新確認敏感資訊遮罩' : '複製已套用遮罩的圖片'}
          className={`${BUTTON_CLASS} min-w-[88px] hover:bg-stone-200 hover:text-stone-700 disabled:opacity-50 dark:hover:bg-stone-700 dark:hover:text-stone-100`}
        >
          {copying ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : copied ? (
            <Check className="size-3.5 text-lime-700 dark:text-lime-400" />
          ) : (
            <Copy className="size-3.5" />
          )}
          <span aria-live="polite">{copying ? '複製中' : copied ? '已複製' : '複製圖片'}</span>
        </button>

        <button
          type="button"
          onClick={() => void handleRecapture()}
          onPointerDown={(event) => event.preventDefault()}
          disabled={!onRecapture || operationsDisabled || recapturing || deleting || copying || Boolean(recaptureDisabledReason)}
          title={recaptureDisabledReason ?? (operationsDisabled ? '目前無法補拍步驟' : '回到來源頁面重新框選並拍攝')}
          className={`${BUTTON_CLASS} hover:bg-stone-200 hover:text-stone-700 disabled:cursor-not-allowed disabled:opacity-40 dark:hover:bg-stone-700 dark:hover:text-stone-100`}
        >
          {recapturing ? <Loader2 className="size-3.5 animate-spin" /> : <Camera className="size-3.5" />}
          {recapturing ? '準備中' : '補拍'}
        </button>
        <button
          type="button"
          onClick={handleDelete}
          onPointerDown={(event) => event.preventDefault()}
          disabled={deleteDisabled || operationsDisabled || deleting || copying || recapturing}
          title={deleteDisabled ? '錄製或補拍期間無法刪除步驟' : '刪除步驟'}
          className={`${BUTTON_CLASS} hover:bg-red-50 hover:text-red-700 disabled:cursor-not-allowed disabled:opacity-40 dark:hover:bg-stone-700 dark:hover:text-red-300`}
        >
          {deleting ? <Loader2 className="size-3.5 animate-spin" /> : <Trash2 className="size-3.5" />}
          {deleting ? '刪除中' : '刪除'}
        </button>
      </div>
      {actionError && <span role="alert" className="text-xs text-red-600 dark:text-red-400">{actionError}</span>}
    </div>
  );
}
