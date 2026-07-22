import { useState } from 'react';
import { Check, Image, ListChecks, Loader2, RotateCcw, ShieldCheck } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import type { RecordingMode } from '@/lib/messages';

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

const MODES: Array<{
  mode: RecordingMode;
  title: string;
  modeLabel: string;
  description: string;
  detail: string;
  Icon: typeof ListChecks;
}> = [
  {
    mode: 'steps',
    title: '完整模式',
    modeLabel: '操作流程',
    description: '一邊操作網站，一邊把每次選取記成獨立步驟圖。',
    detail: '適合教學、工作流程與跨頁操作；錄製時仍可正常使用網頁。',
    Icon: ListChecks,
  },
  {
    mode: 'snapshot',
    title: '精簡模式',
    modeLabel: '單頁標註',
    description: '鎖定目前畫面，在同一張乾淨底圖加入多個標註。',
    detail: '適合介面總覽或集中說明；要換畫面時可完成並新增快照。',
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
        className="app-scrollbar max-h-[calc(100vh-32px)] w-[min(680px,calc(100vw-32px))] overflow-y-auto border border-stone-200 bg-white p-0 text-stone-900 dark:border-stone-700 dark:bg-stone-900 dark:text-stone-100"
      >
        <DialogHeader className="border-b border-stone-200 px-6 pt-6 pb-5 pr-14 dark:border-stone-700">
          <p className="text-xs font-semibold text-lime-700 dark:text-lime-300">第一次使用</p>
          <DialogTitle className="text-xl">歡迎使用 FrameTrail</DialogTitle>
          <DialogDescription className="max-w-2xl leading-6 text-stone-600 dark:text-stone-300">
            選擇符合目的的錄製方式。可先選擇精簡或完整模式練習；開始後，頁面上的浮動控制器會陪你完成整段工作。
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-6 px-6 py-5">
          <section aria-labelledby="onboarding-modes-title" className="space-y-3">
            <h2 id="onboarding-modes-title" className="text-sm font-semibold">
              兩種錄製模式
            </h2>
            <div className="grid gap-3 sm:grid-cols-2">
              {MODES.map(({ mode, title, modeLabel, description, detail, Icon }) => (
                <article
                  key={mode}
                  className="flex flex-col rounded-lg border border-stone-200 bg-stone-50 p-4 dark:border-stone-700 dark:bg-stone-800/60"
                >
                  <div className="mb-3 flex items-center gap-2">
                    <span
                      aria-hidden="true"
                      className="flex size-9 items-center justify-center rounded-full bg-lime-100 text-lime-800 dark:bg-lime-950 dark:text-lime-300"
                    >
                      <Icon className="size-4" />
                    </span>
                    <div>
                      <h3 className="font-semibold">{title}</h3>
                      <p className="text-xs text-stone-600 dark:text-stone-300">{modeLabel}</p>
                    </div>
                  </div>
                  <p className="text-sm leading-6 text-stone-700 dark:text-stone-200">{description}</p>
                  <p className="mt-1 text-xs leading-5 text-stone-600 dark:text-stone-300">{detail}</p>
                  {onStartPractice && (
                    <Button
                      type="button"
                      variant="outline"
                      className="mt-4 w-full border-stone-300 bg-white dark:border-stone-600 dark:bg-stone-900"
                      disabled={pending}
                      onClick={() => void runAction(mode, async () => {
                        await onComplete?.();
                        await onStartPractice(mode);
                      })}
                    >
                      {pendingAction === mode && <Loader2 className="animate-spin" />}
                      練習{title}
                    </Button>
                  )}
                </article>
              ))}
            </div>
          </section>

          <section aria-labelledby="onboarding-controls-title" className="space-y-3">
            <div className="flex items-start gap-3">
              <span
                aria-hidden="true"
                className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full bg-stone-100 text-stone-700 dark:bg-stone-800 dark:text-stone-200"
              >
                <RotateCcw className="size-4" />
              </span>
              <div>
                <h2 id="onboarding-controls-title" className="text-sm font-semibold">
                  如何復原與完成
                </h2>
                <p className="mt-1 text-sm leading-6 text-stone-600 dark:text-stone-300">
                  誤選時按浮動控制器的「復原上一個」。完成後按「完成」或「完成快照」，FrameTrail
                  會開啟編輯器；單頁標註也可用「完成並新增快照」繼續下一張。
                </p>
              </div>
            </div>
          </section>

          <section aria-labelledby="onboarding-privacy-title" className="space-y-3">
            <div className="flex items-start gap-3">
              <span
                aria-hidden="true"
                className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full bg-stone-100 text-stone-700 dark:bg-stone-800 dark:text-stone-200"
              >
                <ShieldCheck className="size-4" />
              </span>
              <div>
                <h2 id="onboarding-privacy-title" className="text-sm font-semibold">
                  內容只留在本機
                </h2>
                <p className="mt-1 text-sm leading-6 text-stone-600 dark:text-stone-300">
                  截圖、標註、指南與導覽完成狀態只保存在這個瀏覽器的本機儲存空間，不會上傳到外部服務。你可以在編輯器刪除內容，或清除擴充功能的本機資料。
                </p>
              </div>
            </div>
          </section>

          {actionError && (
            <p role="alert" className="text-sm text-rose-700 dark:text-rose-300">
              {actionError}
            </p>
          )}
        </div>

        <DialogFooter className="border-t border-stone-200 px-6 py-4 dark:border-stone-700">
          <Button
            type="button"
            className="h-10 bg-lime-700 text-white hover:bg-lime-800 dark:bg-lime-400 dark:text-stone-900 dark:hover:bg-lime-300"
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
