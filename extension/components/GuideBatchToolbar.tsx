import { useCallback, useState, type ReactNode } from 'react';
import {
  Copy,
  Hash,
  ListEnd,
  ListStart,
  ListTodo,
  Plus,
  Trash2,
  X,
} from 'lucide-react';

/** A callback may finish synchronously or after its owner completes an async operation. */
type MaybePromise = void | Promise<void>;

export interface GuideBatchToolbarProps {
  /** Selected entry ids in their current timeline order. */
  selectedEntryIds: readonly string[];
  /** Entry ids currently shown after filtering. */
  visibleEntryIds: readonly string[];
  /** The entry shown in the editor stage, if there is one. */
  activeEntryId: string | null;
  /** Whether snapshot numbers are currently displayed. */
  snapshotNumberingEnabled: boolean;
  /** Disables the toolbar while its owner is performing an operation. */
  busy?: boolean;
  onSelectAllVisible: (visibleEntryIds: readonly string[]) => MaybePromise;
  onClearSelection: () => MaybePromise;
  onDeleteSelected: (selectedEntryIds: readonly string[]) => MaybePromise;
  onMoveSelectedToStart: (selectedEntryIds: readonly string[]) => MaybePromise;
  onMoveSelectedToEnd: (selectedEntryIds: readonly string[]) => MaybePromise;
  onCopyActiveEntry: (activeEntryId: string) => MaybePromise;
  onSetSnapshotNumbering: (enabled: boolean) => MaybePromise;
  onAddSectionBefore: (firstSelectedEntryId: string) => MaybePromise;
}

interface ToolbarButtonProps {
  label: string;
  children: ReactNode;
  disabled: boolean;
  destructive?: boolean;
  pressed?: boolean;
  onClick: () => void;
}

function ToolbarButton({
  label,
  children,
  disabled,
  destructive = false,
  pressed,
  onClick,
}: ToolbarButtonProps) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={pressed}
      disabled={disabled}
      onClick={onClick}
      className={[
        'inline-flex min-h-9 items-center justify-center gap-1.5 rounded-md border px-3 py-2 text-sm font-medium transition-colors',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2',
        'disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50',
        destructive
          ? 'border-red-700 bg-red-700 text-white hover:bg-red-800 dark:border-red-600 dark:bg-red-600 dark:hover:bg-red-700'
          : 'border-stone-300 bg-white text-stone-800 hover:bg-stone-100 dark:border-stone-600 dark:bg-stone-800 dark:text-stone-100 dark:hover:bg-stone-700',
      ].join(' ')}
    >
      {children}
    </button>
  );
}

/**
 * A presentation-only action bar for operations on an ordered selection of guide
 * entries. Persisting, confirmation, and selection state remain with the parent.
 */
export function GuideBatchToolbar({
  selectedEntryIds,
  visibleEntryIds,
  activeEntryId,
  snapshotNumberingEnabled,
  busy = false,
  onSelectAllVisible,
  onClearSelection,
  onDeleteSelected,
  onMoveSelectedToStart,
  onMoveSelectedToEnd,
  onCopyActiveEntry,
  onSetSnapshotNumbering,
  onAddSectionBefore,
}: GuideBatchToolbarProps) {
  const [submitting, setSubmitting] = useState(false);
  const disabled = busy || submitting;
  const firstSelectedEntryId = selectedEntryIds[0];

  const runAction = useCallback((action: () => MaybePromise) => {
    if (busy || submitting) return;

    setSubmitting(true);
    void (async () => {
      try {
        await action();
      } catch {
        // The parent owns operation errors; keeping the toolbar callback-only
        // also lets it decide how errors should be announced to the user.
      } finally {
        setSubmitting(false);
      }
    })();
  }, [busy, submitting]);

  if (selectedEntryIds.length === 0) return null;

  return (
    <section
      aria-label="批次操作列"
      className="flex flex-col gap-3 border-y border-stone-200 bg-stone-50 px-3 py-3 dark:border-stone-700 dark:bg-stone-900"
    >
      <p role="status" aria-live="polite" aria-atomic="true" className="text-sm font-medium text-stone-700 dark:text-stone-200">
        已選 {selectedEntryIds.length} 個
        {submitting && <span className="ml-2 text-stone-500 dark:text-stone-400">正在處理批次操作，請稍候。</span>}
      </p>

      <div className="flex flex-wrap items-center gap-2" aria-label="批次操作">
        <ToolbarButton
          label="全選目前可見的項目"
          disabled={disabled}
          onClick={() => runAction(() => onSelectAllVisible(visibleEntryIds))}
        >
          <ListTodo className="size-4" aria-hidden="true" />
          全選目前可見
        </ToolbarButton>
        <ToolbarButton
          label="清除多重選取"
          disabled={disabled}
          onClick={() => runAction(onClearSelection)}
        >
          <X className="size-4" aria-hidden="true" />
          清除多選
        </ToolbarButton>
        <ToolbarButton
          label="刪除已選的項目（危險操作）"
          destructive
          disabled={disabled}
          onClick={() => runAction(() => onDeleteSelected(selectedEntryIds))}
        >
          <Trash2 className="size-4" aria-hidden="true" />
          刪除已選項目
        </ToolbarButton>
        <ToolbarButton
          label="將已選項目移到開頭"
          disabled={disabled}
          onClick={() => runAction(() => onMoveSelectedToStart(selectedEntryIds))}
        >
          <ListStart className="size-4" aria-hidden="true" />
          移到開頭
        </ToolbarButton>
        <ToolbarButton
          label="將已選項目移到結尾"
          disabled={disabled}
          onClick={() => runAction(() => onMoveSelectedToEnd(selectedEntryIds))}
        >
          <ListEnd className="size-4" aria-hidden="true" />
          移到結尾
        </ToolbarButton>
        <ToolbarButton
          label="複製目前 active 項目"
          disabled={disabled || activeEntryId === null}
          onClick={() => {
            if (activeEntryId) runAction(() => onCopyActiveEntry(activeEntryId));
          }}
        >
          <Copy className="size-4" aria-hidden="true" />
          複製目前項目
        </ToolbarButton>
        <ToolbarButton
          label={`快照編號：${snapshotNumberingEnabled ? '開' : '關'}`}
          pressed={snapshotNumberingEnabled}
          disabled={disabled}
          onClick={() => runAction(() => onSetSnapshotNumbering(!snapshotNumberingEnabled))}
        >
          <Hash className="size-4" aria-hidden="true" />
          快照編號：{snapshotNumberingEnabled ? '開' : '關'}
        </ToolbarButton>
        <ToolbarButton
          label="在第一個選取項目前新增章節"
          disabled={disabled}
          onClick={() => runAction(() => onAddSectionBefore(firstSelectedEntryId))}
        >
          <Plus className="size-4" aria-hidden="true" />
          新增章節
        </ToolbarButton>
      </div>
    </section>
  );
}

export default GuideBatchToolbar;
