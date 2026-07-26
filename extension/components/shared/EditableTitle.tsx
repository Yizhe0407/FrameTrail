import { useEffect, useRef, useState } from 'react';
import { cn } from '@/lib/shared/utils';

interface Props {
  value: string;
  /** Commit the trimmed, changed title. Rejecting reverts the field. */
  onCommit: (title: string) => void | Promise<void>;
  /** Reported when a commit rejects, so the owner can surface the reason. */
  onCommitError?: (error: unknown) => void;
  /** Shown when `value` is empty. Also what an emptied field reverts to. */
  fallback: string;
  label: string;
  maxLength?: number;
  disabled?: boolean;
  className?: string;
}

/**
 * A title field that owns its draft while focused and never silently keeps an
 * unsaved value: an empty or unchanged entry reverts, and a rejected commit
 * reverts too, so what is displayed is always what is stored. Callers that
 * bind a raw input to `defaultValue` and reassign `event.currentTarget.value`
 * lose that guarantee the moment the write fails.
 */
export default function EditableTitle({
  value,
  onCommit,
  onCommitError,
  fallback,
  label,
  maxLength = 120,
  disabled = false,
  className,
}: Props) {
  const committed = value || fallback;
  const [draft, setDraft] = useState(committed);
  const [editing, setEditing] = useState(false);
  const committing = useRef(false);
  // Escape must cancel, but `blur()` dispatches focusout synchronously —
  // before React re-renders — so the blur commit still sees the edited draft.
  // This ref is the only signal that survives that ordering.
  const cancelled = useRef(false);

  // An external rename (undo, another tab, a failed write reloading the guide)
  // wins whenever the user is not mid-edit.
  useEffect(() => {
    if (!editing) setDraft(committed);
  }, [committed, editing]);

  async function commit() {
    if (cancelled.current) {
      cancelled.current = false;
      return;
    }
    const next = draft.trim();
    if (!next || next === committed) {
      setDraft(committed);
      return;
    }
    if (committing.current) return;
    committing.current = true;
    try {
      await onCommit(next);
    } catch (commitError) {
      setDraft(committed);
      onCommitError?.(commitError);
    } finally {
      committing.current = false;
    }
  }

  return (
    <input
      aria-label={label}
      value={draft}
      maxLength={maxLength}
      disabled={disabled}
      onChange={(event) => setDraft(event.target.value)}
      onFocus={() => {
        cancelled.current = false;
        setEditing(true);
      }}
      onBlur={() => {
        setEditing(false);
        void commit();
      }}
      onKeyDown={(event) => {
        if (event.nativeEvent.isComposing) return;
        if (event.key === 'Enter') {
          event.preventDefault();
          event.currentTarget.blur();
        } else if (event.key === 'Escape') {
          event.preventDefault();
          cancelled.current = true;
          setDraft(committed);
          setEditing(false);
          event.currentTarget.blur();
        }
      }}
      className={cn('bg-transparent outline-none', className)}
    />
  );
}
