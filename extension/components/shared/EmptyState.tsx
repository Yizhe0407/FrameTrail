import { useState } from 'react';
import { ExternalLink, Loader2, MousePointerClick } from 'lucide-react';
import { browser } from 'wxt/browser';
import { Button } from '@/components/ui/button';

interface Props {
  isRecording?: boolean;
  recordingTabId?: number | null;
}

function isRecordableTabUrl(url: string | undefined): boolean {
  return Boolean(url && /^(https?|file):/i.test(url));
}

export default function EmptyState({ isRecording = false, recordingTabId = null }: Props) {
  const [pending, setPending] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  async function returnToRecordingPage() {
    if (pending) return;
    setPending(true);
    setActionError(null);
    try {
      const tabs = await browser.tabs.query({ currentWindow: true });
      const target =
        tabs.find((tab) => tab.id === recordingTabId) ??
        tabs
          .filter((tab) => tab.id != null && isRecordableTabUrl(tab.url))
          .sort((first, second) => (second.lastAccessed ?? 0) - (first.lastAccessed ?? 0))[0];
      if (target?.id == null) throw new Error('找不到可錄製的網頁分頁。');

      const focusedTab = await browser.tabs.update(target.id, { active: true });
      if (focusedTab?.windowId != null) await browser.windows.update(focusedTab.windowId, { focused: true });

      if (!isRecording) {
        const browserApis = browser as typeof browser & {
          browserAction?: { openPopup?: () => Promise<void> };
        };
        const actionApi = browserApis.action ?? browserApis.browserAction;
        await actionApi?.openPopup?.();
      }
    } catch (error) {
      console.error('回到錄製頁面失敗', error);
      setActionError(error instanceof Error ? error.message : '無法回到錄製頁面，請重試。');
    } finally {
      setPending(false);
    }
  }

  return (
    <main className="flex flex-1 flex-col items-center justify-center gap-6 px-6 text-center">
      <span className="flex size-14 items-center justify-center rounded-full border border-stone-200 bg-stone-100 dark:border-stone-700 dark:bg-stone-800">
        <MousePointerClick className="size-[22px] text-stone-400 dark:text-stone-500" />
      </span>
      <div className="flex max-w-[380px] flex-col items-center gap-4">
        <h2 className="text-base font-semibold text-stone-800 dark:text-stone-100">尚未建立內容</h2>
        <Button
          onClick={returnToRecordingPage}
          disabled={pending}
          className="h-10 bg-lime-700 text-white hover:bg-lime-800 dark:bg-lime-400 dark:text-stone-900 dark:hover:bg-lime-300"
        >
          {pending ? <Loader2 className="animate-spin" /> : <ExternalLink />}
          {pending ? '正在開啟' : isRecording ? '回到錄製分頁' : '回到網頁開始錄製'}
        </Button>
        {actionError && <p role="alert" className="text-xs text-red-700 dark:text-red-300">{actionError}</p>}
      </div>
    </main>
  );
}
