import { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { updateStep, type Step } from '@/lib/db';
import { Textarea } from '@/components/ui/textarea';

interface Props {
  step: Step;
  onChange: () => void | Promise<void>;
}

export default function DescriptionField({ step, onChange }: Props) {
  const [description, setDescription] = useState(step.description);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    setDescription(step.description);
    setSaving(false);
    setSaveError(null);
  }, [step.id, step.description]);

  async function saveDescription() {
    if (saving || description === step.description) return;
    const stepId = step.id;
    const nextDescription = description;
    setSaving(true);
    setSaveError(null);
    try {
      await updateStep(stepId, { description: nextDescription });
      await onChange();
    } catch (err) {
      console.error('儲存步驟說明失敗', err);
      setSaveError('說明儲存失敗，請再試一次。');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <label className="text-[11px] tracking-[.16em] text-stone-400 dark:text-stone-500">說明</label>
      <Textarea
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        onBlur={saveDescription}
        disabled={saving}
        placeholder="輸入步驟說明…"
        className="min-h-16 resize-none rounded-xl border-stone-200 bg-stone-50 px-4 py-3.5 text-sm leading-[1.7] text-stone-700 shadow-none hover:border-stone-300 dark:border-stone-700 dark:bg-stone-900 dark:text-stone-300 dark:hover:border-stone-600"
      />
      {(saving || saveError) && (
        <div
          role={saveError ? 'alert' : 'status'}
          className={`flex items-center gap-1.5 text-xs ${saveError ? 'text-red-600 dark:text-red-400' : 'text-stone-400 dark:text-stone-500'}`}
        >
          {saving && <Loader2 className="size-3 animate-spin" />}
          {saveError ?? '正在儲存…'}
        </div>
      )}
    </div>
  );
}
