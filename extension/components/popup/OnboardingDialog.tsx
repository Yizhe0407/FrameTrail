import { useState } from 'react';
import {
  Check,
  Download,
  Image,
  ListChecks,
  Loader2,
  MousePointerClick,
  PencilLine,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import type { RecordingMode } from '@/lib/runtime/messages';

export interface OnboardingDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called before the dialog closes when the user finishes onboarding. */
  onComplete?: () => void | Promise<void>;
  /**
   * When provided, each mode shows a practice action. The callback decides how
   * to start the local practice flow; no external page or content is opened by
   * this component.
   */
  onStartPractice?: (mode: RecordingMode) => void | Promise<void>;
}

type PendingAction = 'complete' | RecordingMode | null;

const WORKFLOW = [
  {
    number: '01',
    title: '錄製',
    description: '選擇錄製方式，在網頁上選取要說明的元素。',
    Icon: MousePointerClick,
  },
  {
    number: '02',
    title: '編輯',
    description: '完成錄製後開啟編輯器，整理步驟並補上說明。',
    Icon: PencilLine,
  },
  {
    number: '03',
    title: '匯出',
    description: '確認內容後，從「發佈教學」下載、複製或列印。',
    Icon: Download,
  },
];

const MODES = [
  {
    mode: 'steps' as const,
    title: '操作流程',
    description: '依實際點選順序建立多張步驟圖。',
    useCase: '跨頁、表單與連續操作。',
    practiceLabel: '練習操作流程',
    Icon: ListChecks,
  },
  {
    mode: 'snapshot' as const,
    title: '單頁標註',
    description: '停在同一畫面，對同一張圖加入多個標註。',
    useCase: '畫面導覽、欄位總覽與介面說明。',
    practiceLabel: '練習單頁標註',
    Icon: Image,
  },
];

export default function OnboardingDialog({
  open,
  onOpenChange,
  onComplete,
  onStartPractice,
}: OnboardingDialogProps) {
  const [pendingAction, setPendingAction] = useState<PendingAction>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const pending = pendingAction !== null;

  async function runAction(action: Exclude<PendingAction, null>, callback?: () => void | Promise<void>) {
    if (pending) return;
    setPendingAction(action);
    setActionError(null);
    try {
      await callback?.();
      onOpenChange(false);
    } catch (error) {
      console.error('[frametrail] onboarding action failed', error);
      setActionError('無法開始，請再試一次。');
    } finally {
      setPendingAction(null);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !pending && onOpenChange(next)}>
      <DialogContent
        aria-busy={pending || undefined}
        onEscapeKeyDown={(event) => pending && event.preventDefault()}
        onPointerDownOutside={(event) => pending && event.preventDefault()}
        className="app-scrollbar max-h-[calc(100vh-32px)] w-[min(720px,calc(100vw-32px))] overflow-y-auto border border-stone-200 bg-white p-0 text-stone-900 shadow-xl dark:border-stone-700 dark:bg-stone-950 dark:text-stone-100"
      >
        <DialogHeader className="border-b border-stone-200 px-6 pt-7 pb-6 pr-14 dark:border-stone-700 sm:px-8">
          <p className="text-xs font-medium text-lime-700 dark:text-lime-300">FrameTrail · 開始導覽</p>
          <DialogTitle className="mt-2 text-2xl font-semibold">歡迎使用 FrameTrail</DialogTitle>
          <DialogDescription className="mt-2 max-w-2xl text-sm leading-6 text-stone-600 dark:text-stone-300">
            把網頁操作整理成教學：錄製、編輯，再匯出。每一步都可回來調整。
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-8 px-6 py-7 sm:px-8">
          <section aria-labelledby="onboarding-workflow-title">
            <div className="flex items-baseline justify-between gap-4">
              <h2 id="onboarding-workflow-title" className="text-sm font-semibold">
                三步完成一份教學
              </h2>
              <span className="text-xs text-stone-500 dark:text-stone-400">錄製 → 編輯 → 匯出</span>
            </div>
            <ol className="mt-4 grid border-y border-stone-200 dark:border-stone-700 sm:grid-cols-3">
              {WORKFLOW.map(({ number, title, description, Icon }) => (
                <li key={number} className="min-w-0 border-stone-200 py-4 sm:border-r sm:px-4 sm:first:pl-0 sm:last:border-r-0 sm:last:pr-0 dark:border-stone-700">
                  <div className="flex items-center gap-2 text-stone-500 dark:text-stone-400">
                    <Icon aria-hidden="true" className="size-4" />
                    <span className="font-mono text-[11px]">{number}</span>
                  </div>
                  <h3 className="mt-3 text-sm font-semibold">{title}</h3>
                  <p className="mt-1 text-xs leading-5 text-stone-600 dark:text-stone-300">{description}</p>
                </li>
              ))}
            </ol>
          </section>

          <section aria-labelledby="onboarding-modes-title">
            <div className="border-l-2 border-lime-600 pl-3 dark:border-lime-400">
              <h2 id="onboarding-modes-title" className="text-sm font-semibold">先選錄製方式</h2>
              <p className="mt-1 text-sm leading-6 text-stone-600 dark:text-stone-300">
                兩種方式的差別，在於要不要跟著操作順序走。
              </p>
            </div>

            <div className="mt-4 divide-y divide-stone-200 border-y border-stone-200 dark:divide-stone-700 dark:border-stone-700">
              {MODES.map(({ mode, title, description, useCase, practiceLabel, Icon }) => (
                <div key={mode} className="grid gap-3 py-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center sm:gap-8">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <Icon aria-hidden="true" className="size-4 text-lime-700 dark:text-lime-300" />
                      <h3 className="text-sm font-semibold">{title}</h3>
                    </div>
                    <p className="mt-2 text-sm leading-6 text-stone-700 dark:text-stone-200">{description}</p>
                    <p className="mt-1 text-xs leading-5 text-stone-500 dark:text-stone-400">
                      <span className="font-medium text-stone-700 dark:text-stone-200">適合：</span>{useCase}
                    </p>
                  </div>
                  {onStartPractice && (
                    <Button
                      type="button"
                      variant="outline"
                      aria-label={practiceLabel}
                      className="w-full border-stone-300 bg-transparent text-stone-800 hover:border-lime-700 hover:bg-lime-50 sm:w-auto dark:border-stone-600 dark:text-stone-100 dark:hover:border-lime-400 dark:hover:bg-lime-950/30"
                      disabled={pending}
                      onClick={() => void runAction(mode, async () => {
                        await onComplete?.();
                        await onStartPractice(mode);
                      })}
                    >
                      {pendingAction === mode && <Loader2 className="animate-spin" />}
                      {practiceLabel}
                    </Button>
                  )}
                </div>
              ))}
            </div>
          </section>

          {actionError && (
            <p role="alert" className="border-l-2 border-rose-600 pl-3 text-sm text-rose-700 dark:border-rose-400 dark:text-rose-300">
              {actionError}
            </p>
          )}
        </div>

        <DialogFooter className="border-t border-stone-200 px-6 py-4 dark:border-stone-700 sm:px-8">
          <Button
            type="button"
            className="h-10 bg-lime-700 text-white hover:bg-lime-800 dark:bg-lime-400 dark:text-stone-950 dark:hover:bg-lime-300"
            disabled={pending}
            onClick={() => void runAction('complete', onComplete)}
          >
            {pendingAction === 'complete' ? <Loader2 className="animate-spin" /> : <Check />}
            {pendingAction === 'complete' ? '儲存中' : '我知道了'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
