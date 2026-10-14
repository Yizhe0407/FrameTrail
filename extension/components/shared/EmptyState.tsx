import { useState } from 'react';
import { ExternalLink, Loader2 } from 'lucide-react';
import { browser } from 'wxt/browser';
import { Button } from '@/components/ui/button';
import InlineAlert from '@/components/shared/InlineAlert';
import Mascot from '@/components/shared/Mascot';
import { reportError } from '@/components/shared/report-error';
import { byMostRecentlyAccessed } from '@/lib/editor/continuation-tabs';
import { focusTab } from '@/lib/runtime/navigation';
import { isRecordableTab } from '@/lib/shared/restricted-urls';

interface Props {
  isRecording?: boolean;
  recordingTabId?: number | null;
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
      // Prefer the recording tab; otherwise the most recently used recordable
      // tab (http/https only — file: pages can't be recorded).
      const target =
        tabs.find((tab) => tab.id === recordingTabId) ??
        tabs.filter(isRecordableTab).sort(byMostRecentlyAccessed)[0];
      if (target?.id == null) throw new Error('找不到可錄製的網頁分頁。');

      await focusTab(target.id, target.windowId);

      if (!isRecording) {
        const browserApis = browser as typeof browser & {
          browserAction?: { openPopup?: () => Promise<void> };
        };
        const actionApi = browserApis.action ?? browserApis.browserAction;
        await actionApi?.openPopup?.();
      }
    } catch (error) {
      setActionError(reportError('回到錄製頁面失敗', error, '無法回到錄製頁面，請重試。'));
    } finally {
      setPending(false);
    }
  }

  return (
    <main className="flex flex-1 flex-col items-center justify-center gap-6 px-6 text-center">
      <Mascot className="size-16" />
      <div className="flex max-w-[380px] flex-col items-center gap-2">
        <h2 className="text-lg font-bold text-foreground">尚未建立內容</h2>
        <p className="text-sm leading-relaxed text-muted-foreground">
          到想示範的網頁按下「開始錄製」，每一次點擊都會變成這裡的一個步驟。
        </p>
        <Button onClick={returnToRecordingPage} disabled={pending} className="mt-2">
          {pending ? <Loader2 className="animate-spin" /> : <ExternalLink />}
          {pending ? '正在開啟' : isRecording ? '回到錄製分頁' : '回到網頁開始錄製'}
        </Button>
        {actionError && <InlineAlert className="text-left">{actionError}</InlineAlert>}
      </div>
    </main>
  );
}
