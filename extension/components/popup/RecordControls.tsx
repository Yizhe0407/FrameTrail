import { useEffect, useState } from 'react';
import { browser } from 'wxt/browser';
import { AlertCircle, ExternalLink, Info, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { cn } from '@/lib/shared/utils';
import type { RecordingMode, RecordingState, StartRecordingResult } from '@/lib/runtime/messages';
import { ensureSelectedGuide } from '@/lib/guide/guide-actions';
import { needsEditorRecovery } from '@/lib/recording/recording-recovery';
import { isStartRecordingResult, requireRuntimeMessageResult } from '@/lib/runtime/runtime-message-result';

interface Props {
  recording: RecordingState;
  onStarted?: () => void;
  onOpenEditor?: () => void | Promise<void>;
  openingEditor?: boolean;
  className?: string;
}

const MODES: { value: RecordingMode; label: string; description: string }[] = [
  {
    value: 'steps',
    label: '操作流程',
    description: '實際操作網站；每次選取都會建立一張步驟圖。',
  },
  {
    value: 'snapshot',
    label: '單頁標註',
    description: '鎖定目前畫面；在同一張圖加入多個標註。',
  },
];

const RESTRICTED_URL_PREFIXES = [
  'chrome://',
  'chrome-extension://',
  'edge://',
  'about:',
  'https://chrome.google.com/webstore',
  'https://chromewebstore.google.com',
];

function isRestrictedRecordingUrl(url: string | undefined, allowExtensionPage = false): boolean {
  if (!url) return !allowExtensionPage;
  if (allowExtensionPage && url.startsWith(browser.runtime.getURL('/'))) return false;
  return RESTRICTED_URL_PREFIXES.some((prefix) => url.startsWith(prefix));
}

export default function RecordControls({
  recording,
  onStarted,
  onOpenEditor,
  openingEditor = false,
  className,
}: Props) {
  const [mode, setMode] = useState<RecordingMode>('steps');
  const [numbered, setNumbered] = useState(true);
  const [crossPage, setCrossPage] = useState(false);
  const [pending, setPending] = useState(false);
  const [controlError, setControlError] = useState<string | null>(null);
  const [permissionNotice, setPermissionNotice] = useState<string | null>(null);
  const [restrictedPage, setRestrictedPage] = useState(false);

  useEffect(() => {
    let disposed = false;
    void browser.tabs.query({ active: true, currentWindow: true })
      .then(([tab]) => {
        if (!disposed) setRestrictedPage(isRestrictedRecordingUrl(tab?.url, true));
      })
      .catch((error) => {
        console.error('[frametrail] failed to inspect the active tab', error);
        if (!disposed) {
          setRestrictedPage(true);
          setControlError('無法讀取目前分頁，請重新開啟 FrameTrail 後再試一次。');
        }
      });
    return () => {
      disposed = true;
    };
  }, []);

  async function requestCrossPagePermission(): Promise<boolean> {
    try {
      const granted = await browser.permissions.request({ origins: ['<all_urls>'] });
      if (!granted) {
        setCrossPage(false);
        setPermissionNotice('仍可錄製目前頁面');
      } else {
        setPermissionNotice(null);
      }
      return granted;
    } catch (error) {
      console.warn('請求跨頁錄製權限失敗', error);
      setCrossPage(false);
      setPermissionNotice('仍可錄製目前頁面');
      return false;
    }
  }

  async function handleCrossPageChange(checked: boolean) {
    if (!checked) {
      setCrossPage(false);
      setPermissionNotice(null);
      return;
    }
    setControlError(null);
    const granted = await requestCrossPagePermission();
    setCrossPage(granted);
  }

  async function start() {
    if (pending || restrictedPage) return;
    setPending(true);
    setControlError(null);
    try {
      const [activeTab] = await browser.tabs.query({ active: true, currentWindow: true });
      if (isRestrictedRecordingUrl(activeTab?.url)) {
        setRestrictedPage(true);
        throw new Error('此瀏覽器頁面不允許錄製');
      }
      let permissionScope: 'current-page' | 'cross-page' = 'current-page';
      if (crossPage) {
        const alreadyGranted = await browser.permissions.contains({ origins: ['<all_urls>'] });
        const granted = alreadyGranted || (await requestCrossPagePermission());
        if (granted) permissionScope = 'cross-page';
      }
      const guide = await ensureSelectedGuide();
      const result = requireRuntimeMessageResult<StartRecordingResult>(
        await browser.runtime.sendMessage({
          type: 'START_RECORDING',
          sessionId: guide.id,
          mode,
          numbered,
          permissionScope,
        }),
        isStartRecordingResult,
        '無法連接錄製服務，請重新整理頁面後再試一次。',
      );
      if (!result.ok) throw new Error(result.error);
      onStarted?.();
    } catch (error) {
      console.error('開始錄製失敗', error);
      setControlError(error instanceof Error ? error.message : '無法開始錄製，請重新整理頁面後再試一次。');
    } finally {
      setPending(false);
    }
  }

  async function focusRecordedTab() {
    if (recording.tabId == null) return;
    const tab = await browser.tabs.update(recording.tabId, { active: true });
    if (tab?.windowId != null) await browser.windows.update(tab.windowId, { focused: true });
    window.close();
  }

  if (!recording.isRecording && needsEditorRecovery(recording.recoverableError)) {
    const editorFailed = recording.recoverableError?.code === 'EDITOR_OPEN_FAILED';
    return (
      <div className={cn('space-y-3', className)}>
        <Button
          className="h-10 w-full bg-lime-700 text-white hover:bg-lime-800 dark:bg-lime-400 dark:text-stone-900 dark:hover:bg-lime-300"
          disabled={openingEditor}
          onClick={() => void onOpenEditor?.()}
        >
          {openingEditor ? <Loader2 className="animate-spin" /> : <ExternalLink />}
          {openingEditor ? '正在開啟編輯器' : editorFailed ? '重試開啟編輯器' : '完成並開啟編輯器'}
        </Button>
      </div>
    );
  }

  if (recording.isRecording && recording.runId && recording.phase !== 'starting') {
    const modeLabel = recording.mode === 'steps' ? '操作流程' : '單頁標註';
    const itemLabel = recording.mode === 'steps' ? '個步驟' : '個標註';
    return (
      <div className={cn('space-y-4', className)}>
        <div className="border-y border-stone-200 py-4 dark:border-stone-700">
          <div className="flex items-center gap-2 text-sm font-semibold text-stone-800 dark:text-stone-100">
            <span className="size-2 rounded-full bg-rose-700 dark:bg-rose-400" />
            {recording.phase === 'paused' ? '已暫停' : modeLabel} · {recording.itemCount} {itemLabel}
          </div>
          <p className="mt-2 text-xs leading-[18px] text-stone-600 dark:text-stone-300">
            錄製控制保留在原分頁右下角。
          </p>
        </div>
        <Button
          className="h-10 w-full bg-lime-700 text-white hover:bg-lime-800 dark:bg-lime-400 dark:text-stone-900 dark:hover:bg-lime-300"
          onClick={focusRecordedTab}
        >
          <ExternalLink />
          回到錄製分頁
        </Button>
      </div>
    );
  }

  const activeMode = MODES.find((candidate) => candidate.value === mode)!;

  return (
    <div className={cn('space-y-4', className)}>
      {permissionNotice && (
        <p role="status" className="flex items-start gap-2 rounded-md bg-amber-50 px-3 py-2 text-xs leading-[18px] text-amber-800 dark:bg-amber-950/30 dark:text-amber-200">
          <Info className="mt-0.5 size-4 shrink-0" />
          <span>{permissionNotice}</span>
        </p>
      )}
      {controlError && (
        <p role="alert" className="flex items-start gap-2 rounded-md bg-rose-50 px-3 py-2 text-xs leading-[18px] text-rose-800 dark:bg-rose-950/30 dark:text-rose-200">
          <AlertCircle className="mt-0.5 size-4 shrink-0" />
          <span>{controlError}</span>
        </p>
      )}

      <div className="space-y-2">
        <div role="radiogroup" aria-label="錄製模式" className="grid grid-cols-2 gap-1 rounded-lg bg-stone-100 p-1 dark:bg-stone-800">
          {MODES.map((candidate) => (
            <button
              key={candidate.value}
              type="button"
              role="radio"
              aria-checked={mode === candidate.value}
              onClick={() => setMode(candidate.value)}
              disabled={pending}
              className={cn(
                'h-9 rounded-md px-2 text-sm font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-blue-600',
                mode === candidate.value
                  ? 'bg-white text-stone-900 shadow-sm dark:bg-stone-700 dark:text-stone-50'
                  : 'text-stone-600 hover:text-stone-900 dark:text-stone-300 dark:hover:text-white',
              )}
            >
              {candidate.label}
            </button>
          ))}
        </div>
        <p className="text-xs leading-[18px] text-stone-600 dark:text-stone-300">{activeMode.description}</p>
      </div>

      {mode === 'snapshot' && (
        <label className="flex min-h-10 cursor-pointer items-center justify-between gap-3 border-t border-stone-200 pt-4 dark:border-stone-700">
          <span className="text-sm font-medium text-stone-800 dark:text-stone-100">顯示順序編號</span>
          <Switch
            checked={numbered}
            onCheckedChange={setNumbered}
            disabled={pending}
            className="data-[state=checked]:bg-lime-700 dark:data-[state=checked]:bg-lime-400"
          />
        </label>
      )}

      <div className="space-y-2 border-t border-stone-200 pt-4 dark:border-stone-700">
        <label className="flex min-h-10 cursor-pointer items-center justify-between gap-3">
          <span className="text-sm font-medium text-stone-800 dark:text-stone-100">跨頁錄製</span>
          <Switch
            checked={crossPage}
            onCheckedChange={handleCrossPageChange}
            disabled={pending}
            className="data-[state=checked]:bg-lime-700 dark:data-[state=checked]:bg-lime-400"
          />
        </label>
        <p className="text-xs leading-[18px] text-stone-600 dark:text-stone-300">
          允許導覽後繼續錄製，也能辨識跨網域內嵌內容。
        </p>
      </div>

      {restrictedPage && (
        <p role="status" className="text-xs leading-[18px] text-rose-700 dark:text-rose-300">
          此瀏覽器頁面不允許錄製
        </p>
      )}
      <Button
        className="h-10 w-full bg-lime-700 text-white hover:bg-lime-800 dark:bg-lime-400 dark:text-stone-900 dark:hover:bg-lime-300"
        onClick={start}
        disabled={pending || restrictedPage}
      >
        <span className="inline-flex w-4 justify-center">
          {pending ? <Loader2 className="animate-spin" /> : <span className="size-2 rounded-full bg-rose-200" />}
        </span>
        {pending ? (mode === 'snapshot' ? '正在建立乾淨底圖' : '正在連接頁面') : '開始'}
      </Button>
    </div>
  );
}
