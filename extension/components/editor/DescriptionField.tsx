import { PERSISTED_STEP_LIMITS } from '@/lib/storage/persistence-limits';
import { type Step } from '@/lib/storage/models';
import { useStepDescriptionAutosave } from '@/lib/editor/editor-autosave';
import { Textarea } from '@/components/ui/textarea';
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
    recoveries,
    restoreRecovery,
    discardRecovery,
    flush,
    confirmOverwrite,
  } = useStepDescriptionAutosave(step, onChange);

  return (
    <div className="mt-4 flex w-full flex-col gap-2">
      <div className="flex items-center justify-between">
        <label htmlFor={`description-${step.id}`} className="text-[11px] font-semibold text-muted-foreground">
          說明
        </label>
      </div>
      <Textarea
        id={`description-${step.id}`}
        value={description}
        maxLength={PERSISTED_STEP_LIMITS.maxDescriptionLength}
        onChange={(e) => setDescription(e.target.value)}
        onBlur={() => void flush().catch(() => undefined)}
        disabled={disabled}
        placeholder="輸入步驟說明…"
        className="min-h-[64px] resize-none rounded-md border border-border bg-card p-[13px_15px] text-[14px] leading-[1.7] text-foreground shadow-none hover:border-foreground/20"
      />
      <DescriptionDraftRecoveries
        recoveries={recoveries}
        onRestore={restoreRecovery}
        onDiscard={discardRecovery}
        onConfirmOverwrite={() => confirmOverwrite()}
        disabled={disabled}
      />
    </div>
  );
}
