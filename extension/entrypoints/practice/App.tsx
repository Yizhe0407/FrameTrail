import { useState } from 'react';
import { Check, Image, MousePointerClick, ShieldCheck, Type } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { RecordingMode } from '@/lib/storage/recording-state';

function practiceModeFromLocation(search: string): RecordingMode {
  return new URLSearchParams(search).get('mode') === 'snapshot' ? 'snapshot' : 'steps';
}

const modeDetails: Record<RecordingMode, { title: string; description: string }> = {
  steps: {
    title: '完整模式：操作流程',
    description: '每次選取都會成為一個獨立步驟，適合練習跨畫面操作。',
  },
  snapshot: {
    title: '精簡模式：單頁標註',
    description: '在同一張示範快照上加入多個標註，適合練習介面說明。',
  },
};

export default function PracticeApp() {
  const mode = practiceModeFromLocation(window.location.search);
  const [checklistChecked, setChecklistChecked] = useState(false);
  const [lastAction, setLastAction] = useState<string | null>(null);
  const details = modeDetails[mode];

  return (
    <main className="min-h-screen bg-background px-4 py-8 text-foreground sm:px-6">
      <div className="mx-auto max-w-3xl space-y-6">
        <header className="rounded-md border border-brand/30 bg-brand/10 p-6">
          <div className="flex items-start gap-3">
            <ShieldCheck aria-hidden="true" className="mt-0.5 size-6 shrink-0 text-brand" />
            <div>
              <p className="text-sm font-semibold text-brand">FrameTrail 本機練習頁</p>
              <h1 className="mt-1 text-2xl font-semibold">{details.title}</h1>
              <p className="mt-2 leading-6 text-foreground">{details.description}</p>
              <p className="mt-3 text-sm leading-6 text-foreground">
                這是擴充功能內建的本機頁面，沒有外部連結、沒有網路請求。練習輸入不會被 FrameTrail
                捕捉、保存或上傳。
              </p>
              <p className="mt-2 text-sm leading-6 text-muted-foreground">
                瀏覽器不允許在擴充功能頁面（包含本頁）錄製。熟悉操作後，請切換到任何一般網站（http／https），
                再從工具列開啟 FrameTrail 按「開始錄製」。
              </p>
            </div>
          </div>
        </header>

        <section aria-labelledby="practice-elements-title" className="rounded-md border border-border bg-card p-6 shadow-[var(--shadow-card)]">
          <h2 id="practice-elements-title" className="text-lg font-semibold">安全練習元素</h2>
          <p className="mt-1 text-sm leading-6 text-muted-foreground">
            可以依序點選、輸入與勾選，熟悉錄製時可辨識的常見介面元素。
          </p>

          <div className="mt-5 grid gap-4 sm:grid-cols-2">
            <section aria-labelledby="practice-click-title" className="rounded-md border border-border p-4">
              <div className="flex items-center gap-2">
                <MousePointerClick aria-hidden="true" className="size-5 text-brand" />
                <h3 id="practice-click-title" className="font-medium">點擊元素</h3>
              </div>
              <p className="mt-2 text-sm text-muted-foreground">點一下此按鈕，確認可選取的按鈕目標。</p>
              <Button type="button" className="mt-4" onClick={() => setLastAction('已練習點擊按鈕。')}>
                練習點擊
              </Button>
            </section>

            <section aria-labelledby="practice-input-title" className="rounded-md border border-border p-4">
              <div className="flex items-center gap-2">
                <Type aria-hidden="true" className="size-5 text-brand" />
                <h3 id="practice-input-title" className="font-medium">文字輸入</h3>
              </div>
              <label htmlFor="practice-note" className="mt-2 block text-sm text-muted-foreground">
                任意輸入一段練習文字（不會保存）
              </label>
              <input
                id="practice-note"
                type="text"
                autoComplete="off"
                placeholder="只存在於目前欄位"
                className="mt-2 w-full rounded-md border border-border bg-card px-3 py-2 text-sm outline-none focus:border-brand focus:ring-2 focus:ring-ring"
              />
            </section>

            <section aria-labelledby="practice-checkbox-title" className="rounded-md border border-border p-4">
              <div className="flex items-center gap-2">
                <Check aria-hidden="true" className="size-5 text-brand" />
                <h3 id="practice-checkbox-title" className="font-medium">核取方塊</h3>
              </div>
              <label className="mt-3 flex cursor-pointer items-center gap-3 text-sm text-foreground">
                <input
                  type="checkbox"
                  checked={checklistChecked}
                  onChange={(event) => setChecklistChecked(event.currentTarget.checked)}
                  className="size-4 accent-brand"
                />
                我已確認這只是本機練習
              </label>
            </section>

            <section aria-labelledby="practice-snapshot-title" className="rounded-md border border-border p-4">
              <div className="flex items-center gap-2">
                <Image aria-hidden="true" className="size-5 text-brand" />
                <h3 id="practice-snapshot-title" className="font-medium">快照標註目標</h3>
              </div>
              <div className="mt-3 rounded-md border-2 border-dashed border-brand bg-brand/10 p-4">
                <p className="text-sm font-medium">示範快照區塊</p>
                <p className="mt-1 text-xs text-muted-foreground">可點選這個本機區塊，練習標註介面區域。</p>
                <Button type="button" variant="outline" className="mt-3" onClick={() => setLastAction('已練習選取快照標註目標。')}>
                  選取快照目標
                </Button>
              </div>
            </section>
          </div>

          <p role="status" aria-live="polite" className="mt-5 min-h-6 text-sm text-brand">
            {lastAction ?? '尚未選取練習元素。'}
          </p>
        </section>

        <p className="text-center text-xs leading-5 text-muted-foreground">
          關閉此分頁即可結束練習；FrameTrail 不會保留本頁的文字輸入內容。
        </p>
      </div>
    </main>
  );
}
