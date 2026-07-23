import type { RestoredDescriptionDraft } from '@/lib/editor-draft-journal';

interface Props {
  recoveries: RestoredDescriptionDraft[];
  onRestore: (writerId: string) => void;
  onDiscard: (writerId: string) => void;
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
  disabled = false,
  className = '',
}: Props) {
  if (recoveries.length === 0) return null;

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
              className="rounded border border-amber-200 bg-white/70 p-2 dark:border-amber-900 dark:bg-stone-950/40"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <time dateTime={date.toISOString()} className="text-amber-700 dark:text-amber-300">
                  {date.toLocaleString('zh-TW')}
                </time>
                {recovery.conflictsWithPersistedValue && (
                  <span className="rounded bg-red-100 px-1.5 py-0.5 font-medium text-red-800 dark:bg-red-950 dark:text-red-200">
                    與已儲存內容衝突
                  </span>
                )}
              </div>
              <p className="mt-1 break-words text-stone-700 dark:text-stone-200">{excerpt(recovery.description)}</p>
              <div className="mt-2 flex gap-2">
                <button
                  type="button"
                  disabled={disabled}
                  aria-label={`載入草稿 ${itemNumber}`}
                  onClick={() => onRestore(recovery.writerId)}
                  className="rounded bg-amber-700 px-2 py-1 font-medium text-white hover:bg-amber-800 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-amber-600 dark:hover:bg-amber-500"
                >
                  載入草稿
                </button>
                <button
                  type="button"
                  disabled={disabled}
                  aria-label={`捨棄草稿 ${itemNumber}`}
                  onClick={() => onDiscard(recovery.writerId)}
                  className="rounded px-2 py-1 font-medium text-red-700 hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-50 dark:text-red-300 dark:hover:bg-red-950/50"
                >
                  捨棄
                </button>
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
