import { useCallback, useState, type ReactNode } from 'react';
import {
  ChevronDown,
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
  /** Entry ids in the current guide timeline. */
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
        'inline-flex h-9 items-center justify-center gap-1.5 rounded-md px-2.5 text-sm font-medium transition-colors',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2',
        'disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50',
        destructive
          ? 'text-red-700 hover:bg-red-50 dark:text-red-300 dark:hover:bg-red-950/30'
          : pressed
            ? 'bg-stone-200 text-stone-900 hover:bg-stone-300 dark:bg-stone-700 dark:text-stone-50 dark:hover:bg-stone-600'
            : 'text-stone-700 hover:bg-stone-200/80 dark:text-stone-200 dark:hover:bg-stone-800',
      ].join(' ')}
    >
      {children}
    </button>
  );
}

/**
 * A compact, contextual action bar for an ordered selection of guide entries.
 * Frequent editing actions stay visible; less frequent and destructive actions
 * are deliberately tucked into a native details disclosure.
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
        // The parent owns operation errors and their announcement.
      } finally {
        setSubmitting(false);
      }
    })();
  }, [busy, submitting]);

  if (selectedEntryIds.length === 0) return null;

  return (
    <section
      aria-label="批次操作列"
      className="border-y border-stone-200 bg-stone-50/80 px-3 py-2.5 dark:border-stone-700 dark:bg-stone-900/80"
    >
      <div className="flex flex-wrap items-center gap-x-1 gap-y-1">
        <div role="status" aria-live="polite" aria-atomic="true" className="mr-auto min-w-0 pr-3">
          <p className="text-sm font-medium text-stone-700 dark:text-stone-200">
            已選取 {selectedEntryIds.length} 個步驟
          </p>
          <p className="text-xs text-stone-500 dark:text-stone-400">
            {submitting ? '正在處理，請稍候。' : '批次操作只會套用到這些步驟。'}
          </p>
        </div>

        <ToolbarButton
          label="結束多選"
          disabled={disabled}
          onClick={() => runAction(onClearSelection)}
        >
          <X className="size-4" aria-hidden="true" />
          結束多選
        </ToolbarButton>
        <ToolbarButton
          label="刪除已選步驟（危險操作）"
          destructive
          disabled={disabled}
          onClick={() => runAction(() => onDeleteSelected(selectedEntryIds))}
        >
          <Trash2 className="size-4" aria-hidden="true" />
          刪除
        </ToolbarButton>

        <details
          className="group relative"
          aria-disabled={disabled || undefined}
        >
          <summary
            onClick={(event) => {
              if (disabled) event.preventDefault();
            }}
            className="inline-flex h-9 cursor-pointer list-none items-center gap-1.5 rounded-md px-2.5 text-sm font-medium text-stone-600 transition-colors hover:bg-stone-200/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2 group-open:bg-stone-200/80 dark:text-stone-300 dark:hover:bg-stone-800 dark:group-open:bg-stone-800 [&::-webkit-details-marker]:hidden"
          >
            更多操作
            <ChevronDown className="size-4 transition-transform group-open:rotate-180" aria-hidden="true" />
          </summary>
          <div className="absolute right-0 top-[calc(100%+0.4rem)] z-20 flex w-56 flex-col rounded-lg border border-stone-200 bg-white p-1.5 shadow-lg dark:border-stone-700 dark:bg-stone-900">
            <ToolbarButton
              label="選取左側目前顯示的所有步驟"
              disabled={disabled}
              onClick={() => runAction(() => onSelectAllVisible(visibleEntryIds))}
            >
              <ListTodo className="size-4" aria-hidden="true" />
              全選左側步驟
            </ToolbarButton>
            <div className="my-1 border-t border-stone-200 dark:border-stone-700" />
            <ToolbarButton
              label="將已選步驟移至開頭"
              disabled={disabled}
              onClick={() => runAction(() => onMoveSelectedToStart(selectedEntryIds))}
            >
              <ListStart className="size-4" aria-hidden="true" />
              移至教學開頭
            </ToolbarButton>
            <ToolbarButton
              label="將已選步驟移至結尾"
              disabled={disabled}
              onClick={() => runAction(() => onMoveSelectedToEnd(selectedEntryIds))}
            >
              <ListEnd className="size-4" aria-hidden="true" />
              移至教學結尾
            </ToolbarButton>
            <ToolbarButton
              label="在已選步驟前新增章節"
              disabled={disabled}
              onClick={() => runAction(() => onAddSectionBefore(firstSelectedEntryId))}
            >
              <Plus className="size-4" aria-hidden="true" />
              在選取處新增章節
            </ToolbarButton>
            <div className="my-1 border-t border-stone-200 dark:border-stone-700" />
            <ToolbarButton
              label="複製目前開啟的步驟"
              disabled={disabled || activeEntryId === null}
              onClick={() => {
                if (activeEntryId) runAction(() => onCopyActiveEntry(activeEntryId));
              }}
            >
              <Copy className="size-4" aria-hidden="true" />
              複製目前步驟
            </ToolbarButton>
            <ToolbarButton
              label="顯示標註編號"
              pressed={snapshotNumberingEnabled}
              disabled={disabled}
              onClick={() => runAction(() => onSetSnapshotNumbering(!snapshotNumberingEnabled))}
            >
              <Hash className="size-4" aria-hidden="true" />
              顯示標註編號
            </ToolbarButton>
          </div>
        </details>
      </div>
    </section>
  );
}

export default GuideBatchToolbar;
