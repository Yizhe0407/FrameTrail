import type { Step } from '@/lib/db';
import { PERSISTED_STEP_LIMITS } from '@/lib/persistence-limits';
import { useStepDescriptionAutosave } from '@/lib/editor-autosave';
import { Textarea } from '@/components/ui/textarea';
import SaveStatus from './SaveStatus';
import DescriptionDraftRecoveries from './DescriptionDraftRecoveries';

interface Props {
  step: Step;
  onChange: () => void | Promise<void>;
  disabled?: boolean;
}

export default function DescriptionField({ step, onChange, disabled = false }: Props) {
  const {
    description,
    setDescription,
    status,
    error,
    recoveries,
    restoreRecovery,
    discardRecovery,
    flush,
    retry,
  } = useStepDescriptionAutosave(step, onChange);

  return (
    <div className="flex flex-col gap-2">
      <label htmlFor={`description-${step.id}`} className="text-xs font-medium text-stone-600 dark:text-stone-300">
        說明
      </label>
      <Textarea
        id={`description-${step.id}`}
        value={description}
        maxLength={PERSISTED_STEP_LIMITS.maxDescriptionLength}
        onChange={(e) => setDescription(e.target.value)}
        onBlur={() => void flush().catch(() => undefined)}
        disabled={disabled}
        placeholder="輸入步驟說明…"
        className="min-h-16 resize-none rounded-md border-stone-200 bg-stone-50 px-4 py-3 text-sm leading-[22px] text-stone-700 shadow-none hover:border-stone-300 dark:border-stone-700 dark:bg-stone-900 dark:text-stone-300 dark:hover:border-stone-600"
      />
      <SaveStatus
        status={status}
        error={error}
        onRetry={() => void retry().catch(() => undefined)}
        className={status === 'error' ? 'text-red-700 dark:text-red-300' : 'text-stone-500 dark:text-stone-400'}
      />
      <DescriptionDraftRecoveries
        recoveries={recoveries}
        onRestore={restoreRecovery}
        onDiscard={discardRecovery}
        disabled={disabled}
      />
    </div>
  );
}
