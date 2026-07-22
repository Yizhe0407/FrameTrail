import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { Pencil, Trash2 } from 'lucide-react';

/** A parent-owned action that may complete synchronously or asynchronously. */
type MaybePromise = void | Promise<void>;

export interface GuideSectionHeadingSection {
  id: string;
  title: string;
  startEntryId: string;
}

export interface GuideSectionHeadingProps {
  section: GuideSectionHeadingSection;
  /** Disables controls when the parent cannot accept a section action. */
  disabled?: boolean;
  /** Indicates that the parent is currently performing a section action. */
  busy?: boolean;
  onRename: (sectionId: string, title: string) => MaybePromise;
  onDelete: (sectionId: string) => MaybePromise;
}

const MAX_TITLE_LENGTH = 200;

function normalizeTitle(value: string): string {
  return value.trim().slice(0, MAX_TITLE_LENGTH);
}

/**
 * A callback-only section heading. Its owner controls persistence, error
 * reporting, and any confirmation UI for destructive actions.
 */
export function GuideSectionHeading({
  section,
  disabled = false,
  busy = false,
  onRename,
  onDelete,
}: GuideSectionHeadingProps) {
  const [editing, setEditing] = useState(false);
  const [draftTitle, setDraftTitle] = useState(section.title);
  const [submitting, setSubmitting] = useState(false);
  const [emptyTitle, setEmptyTitle] = useState(false);
  const actionInFlight = useRef(false);
  const inputId = useId();
  const errorId = useId();
  const controlsDisabled = disabled || busy || submitting;

  useEffect(() => {
    if (!editing) setDraftTitle(section.title);
  }, [editing, section.title]);

  const runAction = useCallback(async (action: () => MaybePromise) => {
    if (disabled || busy || actionInFlight.current) return false;

    actionInFlight.current = true;
    setSubmitting(true);
    try {
      await action();
      return true;
    } catch {
      // Callback owners decide how operation failures are presented.
      return false;
    } finally {
      actionInFlight.current = false;
      setSubmitting(false);
    }
  }, [busy, disabled]);

  const cancelRename = useCallback(() => {
    if (controlsDisabled) return;
    setDraftTitle(section.title);
    setEmptyTitle(false);
    setEditing(false);
  }, [controlsDisabled, section.title]);

  const saveRename = useCallback(async () => {
    if (controlsDisabled) return;

    const title = normalizeTitle(draftTitle);
    if (!title) {
      setEmptyTitle(true);
      return;
    }

    setEmptyTitle(false);
    if (title === section.title) {
      setEditing(false);
      return;
    }

    if (await runAction(() => onRename(section.id, title))) {
      setEditing(false);
    }
  }, [controlsDisabled, draftTitle, onRename, runAction, section.id, section.title]);

  const handleDelete = useCallback(() => {
    void runAction(() => onDelete(section.id));
  }, [onDelete, runAction, section.id]);

  return (
    <section
      aria-label={`章節：${section.title}`}
      className="flex flex-wrap items-center gap-2 border-y border-stone-200 bg-stone-50 px-3 py-2 dark:border-stone-700 dark:bg-stone-900"
    >
      {editing ? (
        <form
          className="flex min-w-0 flex-1 flex-wrap items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            void saveRename();
          }}
        >
          <label htmlFor={inputId} className="sr-only">章節名稱</label>
          <input
            id={inputId}
            type="text"
            value={draftTitle}
            maxLength={MAX_TITLE_LENGTH}
            disabled={controlsDisabled}
            aria-invalid={emptyTitle || undefined}
            aria-describedby={emptyTitle ? errorId : undefined}
            onChange={(event) => {
              setDraftTitle(event.target.value);
              if (emptyTitle) setEmptyTitle(false);
            }}
            onBlur={() => {
              // A blur can happen while leaving the field. Empty text must never
              // become an accidental rename; leave the editor open instead.
              if (!normalizeTitle(draftTitle)) {
                setEmptyTitle(true);
                return;
              }
              void saveRename();
            }}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing) return;
              if (event.key === 'Escape') {
                event.preventDefault();
                cancelRename();
              } else if (event.key === 'Enter') {
                event.preventDefault();
                void saveRename();
              }
            }}
            className="min-w-0 flex-1 rounded-md border border-stone-300 bg-white px-3 py-2 text-sm text-stone-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 dark:border-stone-600 dark:bg-stone-800 dark:text-stone-100"
          />
          {emptyTitle && (
            <p id={errorId} role="alert" className="w-full text-sm text-red-700 dark:text-red-400">
              章節名稱不可為空白。
            </p>
          )}
          <button
            type="submit"
            disabled={controlsDisabled}
            onMouseDown={(event) => event.preventDefault()}
            className="inline-flex min-h-9 items-center justify-center rounded-md border border-blue-700 bg-blue-700 px-3 py-2 text-sm font-medium text-white hover:bg-blue-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
          >
            儲存
          </button>
          <button
            type="button"
            disabled={controlsDisabled}
            onMouseDown={(event) => event.preventDefault()}
            onClick={cancelRename}
            className="inline-flex min-h-9 items-center justify-center rounded-md border border-stone-300 bg-white px-3 py-2 text-sm font-medium text-stone-800 hover:bg-stone-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 dark:border-stone-600 dark:bg-stone-800 dark:text-stone-100 dark:hover:bg-stone-700"
          >
            取消
          </button>
        </form>
      ) : (
        <>
          <div
            role="heading"
            aria-level={2}
            className="min-w-0 flex-1 break-words text-base font-semibold text-stone-900 dark:text-stone-100"
          >
            {section.title}
          </div>
          <div className="flex items-center gap-2" aria-label="章節操作">
            <button
              type="button"
              disabled={controlsDisabled}
              onClick={() => {
                setDraftTitle(section.title);
                setEmptyTitle(false);
                setEditing(true);
              }}
              className="inline-flex min-h-9 items-center justify-center gap-1.5 rounded-md border border-stone-300 bg-white px-3 py-2 text-sm font-medium text-stone-800 hover:bg-stone-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 dark:border-stone-600 dark:bg-stone-800 dark:text-stone-100 dark:hover:bg-stone-700"
            >
              <Pencil className="size-4" aria-hidden="true" />
              重新命名
            </button>
            <button
              type="button"
              disabled={controlsDisabled}
              onClick={handleDelete}
              className="inline-flex min-h-9 items-center justify-center gap-1.5 rounded-md border border-red-700 bg-red-700 px-3 py-2 text-sm font-medium text-white hover:bg-red-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 dark:border-red-600 dark:bg-red-600 dark:hover:bg-red-700"
            >
              <Trash2 className="size-4" aria-hidden="true" />
              刪除
            </button>
          </div>
        </>
      )}
    </section>
  );
}

export default GuideSectionHeading;
