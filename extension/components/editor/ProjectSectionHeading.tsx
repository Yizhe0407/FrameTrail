import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { Pencil, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { t } from '@/lib/shared/i18n';

/** A parent-owned action that may complete synchronously or asynchronously. */
type MaybePromise = void | Promise<void>;

interface ProjectSectionHeadingSection {
  id: string;
  title: string;
  startEntryId: string;
}

export interface ProjectSectionHeadingProps {
  section: ProjectSectionHeadingSection;
  /** Disables controls when the parent cannot accept a section action. */
  disabled?: boolean;
  onRename: (sectionId: string, title: string) => MaybePromise;
  onDelete: (sectionId: string) => MaybePromise;
}

const MAX_TITLE_LENGTH = 200;

function normalizeTitle(value: string): string {
  return value.trim().slice(0, MAX_TITLE_LENGTH);
}

/** A callback-only section heading; the owner controls persistence, error reporting, and any confirmation UI. */
function ProjectSectionHeading({
  section,
  disabled = false,
  onRename,
  onDelete,
}: ProjectSectionHeadingProps) {
  const [editing, setEditing] = useState(false);
  const [draftTitle, setDraftTitle] = useState(section.title);
  const [submitting, setSubmitting] = useState(false);
  const [emptyTitle, setEmptyTitle] = useState(false);
  const actionInFlight = useRef(false);
  const inputId = useId();
  const errorId = useId();
  const controlsDisabled = disabled || submitting;

  useEffect(() => {
    if (!editing) setDraftTitle(section.title);
  }, [editing, section.title]);

  const runAction = useCallback(async (action: () => MaybePromise) => {
    if (disabled || actionInFlight.current) return false;

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
  }, [disabled]);

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
      aria-label={t().editor.sections.label(section.title)}
      className="flex flex-wrap items-center gap-2 rounded-md border-2 border-border bg-secondary px-2.5 py-2"
    >
      {editing ? (
        <form
          className="flex min-w-0 flex-1 flex-wrap items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            void saveRename();
          }}
        >
          <label htmlFor={inputId} className="sr-only">{t().editor.sections.nameLabel}</label>
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
              // Blurring with empty text must never become an accidental rename.
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
            className="h-9 min-w-0 flex-1"
          />
          {emptyTitle && (
            <p id={errorId} role="alert" className="w-full text-xs font-bold text-danger">
              {t().editor.sections.emptyName}
            </p>
          )}
          {/* Suppress mousedown blur so the button the user pressed wins, not the blur handler. */}
          <Button type="submit" size="sm" disabled={controlsDisabled} onMouseDown={(event) => event.preventDefault()}>
            {t().common.save}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={controlsDisabled}
            onMouseDown={(event) => event.preventDefault()}
            onClick={cancelRename}
          >
            {t().common.cancel}
          </Button>
        </form>
      ) : (
        <>
          <h2 className="min-w-0 flex-1 break-words text-sm font-bold text-foreground">
            {section.title}
          </h2>
          <div className="flex items-center gap-2" aria-label={t().editor.sections.actionsLabel}>
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
              {t().common.rename}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="destructive"
              disabled={controlsDisabled}
              onClick={handleDelete}
            >
              <Trash2 aria-hidden="true" />
              {t().common.delete}
            </Button>
          </div>
        </>
      )}
    </section>
  );
}

export default ProjectSectionHeading;
