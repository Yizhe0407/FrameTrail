import { useState } from 'react';
import type { RestoredDescriptionDraft } from '@/lib/editor/editor-draft-journal';

interface Props {
  recoveries: RestoredDescriptionDraft[];
  /** Returns false when the journal refused the restore (the field is untouched). */
  onRestore: (writerId: string) => boolean;
  onDiscard: (writerId: string) => void;
  onConfirmOverwrite?: () => Promise<void>;
  disabled?: boolean;
  className?: string;
}

function excerpt(description: string): string {
  const compact = description.replace(/\s+/gu, ' ').trim();
  return compact.length > 120 ? `${compact.slice(0, 120)}…` : compact || '（空白草稿）';
}

export default function DescriptionDraftRecoveries({
  recoveries,
  onRestore,
  onDiscard,
  onConfirmOverwrite,
  disabled = false,
  className = '',
}: Props) {
  const [confirmingWriterId, setConfirmingWriterId] = useState<string | null>(null);
  const [restoreFailedWriterId, setRestoreFailedWriterId] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  if (recoveries.length === 0) return null;

  function restoreDraft(writerId: string) {
    if (onRestore(writerId)) {
      setRestoreFailedWriterId(null);
      setConfirmingWriterId(writerId);
      return;
    }
    // The journal rejected the write (storage pressure) or the record was
    // cleaned meanwhile; the field is untouched, so say so instead of
    // silently doing nothing.
    setRestoreFailedWriterId(writerId);
    setConfirmingWriterId((current) => (current === writerId ? null : current));
  }

  async function confirmOverwrite() {
    if (!onConfirmOverwrite || confirming) return;
    setConfirming(true);
    try {
      await onConfirmOverwrite();
      setConfirmingWriterId(null);
    } catch {
      // The journal remains intact, so the user can retry the explicit confirmation.
    } finally {
      setConfirming(false);
    }
  }

  return (
    <section
      aria-label="其他分頁的說明草稿"
      className={`rounded-md border border-amber-300 bg-amber-50 p-3 text-xs text-amber-950 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-100 ${className}`}
    >
      <p className="font-medium">找到 {recoveries.length} 份其他分頁或先前版本的草稿</p>
      <p className="mt-1 text-amber-800 dark:text-amber-200">
        草稿不會自動覆寫目前內容。請先載入並確認，或只捨棄不需要的版本。
      </p>
      <ul className="mt-2 max-h-48 space-y-2 overflow-y-auto pr-1">
        {recoveries.map((recovery, index) => {
          const itemNumber = index + 1;
          const date = new Date(recovery.updatedAt);
          return (
            <li
              key={recovery.writerId}
              className="rounded-md border border-amber-200 bg-card/70 p-2 dark:border-amber-900"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <time dateTime={date.toISOString()} className="text-amber-700 dark:text-amber-300">
                  {date.toLocaleString('zh-TW')}
                </time>
                {recovery.conflictsWithPersistedValue && (
                  <span className="rounded-md bg-destructive/15 px-1.5 py-0.5 font-medium text-destructive">
                    與已儲存內容衝突
                  </span>
                )}
              </div>
              <p className="mt-1 break-words text-foreground">{excerpt(recovery.description)}</p>
              <div className="mt-2 flex gap-2">
                <button
                  type="button"
                  disabled={disabled}
                  aria-label={`載入草稿 ${itemNumber}`}
                  onClick={() => restoreDraft(recovery.writerId)}
                  className="rounded-md bg-amber-700 px-2 py-1 font-medium text-white hover:bg-amber-800 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-amber-600 dark:hover:bg-amber-500"
                >
                  載入草稿
                </button>
                <button
                  type="button"
                  disabled={disabled}
                  aria-label={`捨棄草稿 ${itemNumber}`}
                  onClick={() => onDiscard(recovery.writerId)}
                  className="rounded-md px-2 py-1 font-medium text-destructive hover:bg-destructive/10 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  捨棄
                </button>
              </div>
              {restoreFailedWriterId === recovery.writerId && (
                <p role="alert" className="mt-1 font-medium text-destructive">
                  無法載入這份草稿，目前內容未變更。請再試一次，或先捨棄其他草稿。
                </p>
              )}
              {confirmingWriterId === recovery.writerId && onConfirmOverwrite && (
                <div className="mt-2 flex flex-wrap items-center justify-between gap-2 border-t border-amber-200 pt-2 dark:border-amber-900">
                  <span className="text-amber-800 dark:text-amber-200">已載入草稿，確認後才會覆寫目前內容。</span>
                  <button
                    type="button"
                    disabled={disabled || confirming}
                    aria-label={`確認覆寫草稿 ${itemNumber}`}
                    onClick={() => void confirmOverwrite()}
                    className="rounded-md bg-amber-700 px-2 py-1 font-medium text-white hover:bg-amber-800 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-amber-600 dark:hover:bg-amber-500"
                  >
                    確認覆寫
                  </button>
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
