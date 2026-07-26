import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { Pencil, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

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
      className="flex flex-wrap items-center gap-2 border-y border-border bg-secondary px-3 py-2"
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
          <Input
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
            className="min-w-0 flex-1 bg-card text-sm"
          />
          {emptyTitle && (
            <p id={errorId} role="alert" className="w-full text-sm text-destructive">
              章節名稱不可為空白。
            </p>
          )}
          {/* A mousedown on either control would blur the input first and let the
              field's own blur handler decide the outcome; suppress it so the
              button the user actually pressed wins. */}
          <Button type="submit" size="sm" disabled={controlsDisabled} onMouseDown={(event) => event.preventDefault()}>
            儲存
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={controlsDisabled}
            onMouseDown={(event) => event.preventDefault()}
            onClick={cancelRename}
          >
            取消
          </Button>
        </form>
      ) : (
        <>
          <h2 className="min-w-0 flex-1 break-words text-base font-semibold text-foreground">
            {section.title}
          </h2>
          <div className="flex items-center gap-2" aria-label="章節操作">
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={controlsDisabled}
              onClick={() => {
                setDraftTitle(section.title);
                setEmptyTitle(false);
                setEditing(true);
              }}
            >
              <Pencil aria-hidden="true" />
              重新命名
            </Button>
            <Button
              type="button"
              size="sm"
              variant="destructive"
              disabled={controlsDisabled}
              onClick={handleDelete}
            >
              <Trash2 aria-hidden="true" />
              刪除
            </Button>
          </div>
        </>
      )}
    </section>
  );
}

export default GuideSectionHeading;
