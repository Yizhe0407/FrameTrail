import { Loader2, PencilLine } from 'lucide-react';
import { cn } from '@/lib/shared/utils';

interface Props {
  /** Copy while idle. The pending copy is owned here because it is identical on
   * every surface. */
  label: string;
  pending: boolean;
  onOpen?: () => void | Promise<void>;
  /** The three call sites carry deliberately different visual weight (primary
   * in editor recovery, bordered full-width in the idle nav, quiet as the
   * live-run secondary exit), so the button's own class list stays theirs. */
  className?: string;
  iconClassName?: string;
}

const OPENING_EDITOR_LABEL = '正在開啟編輯器';

/**
 * The popup's 「開啟編輯器」 button. It exists once so the pending label, the
 * spinner-or-icon swap and the disabled-while-pending rule cannot drift apart
 * between the idle nav, the editor-recovery branch and the live-run exit.
 */
export default function OpenEditorButton({ label, pending, onOpen, className, iconClassName }: Props) {
  return (
    <button
      type="button"
      onClick={() => void onOpen?.()}
      disabled={pending || !onOpen}
      className={className}
    >
      {pending
        ? <Loader2 className={cn('animate-spin', iconClassName)} />
        : <PencilLine className={iconClassName} />}
      {pending ? OPENING_EDITOR_LABEL : label}
    </button>
  );
}
