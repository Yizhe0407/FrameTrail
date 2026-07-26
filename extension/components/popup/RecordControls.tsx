import { useEffect, useState } from 'react';
import { browser } from 'wxt/browser';
import { AlertCircle, ExternalLink, Info, Loader2, PencilLine } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { cn } from '@/lib/shared/utils';
import type { RecordingMode, RecordingState, StartRecordingResult } from '@/lib/runtime/messages';
import { ensureSelectedGuide } from '@/lib/guide/guide-actions';
import { needsEditorRecovery } from '@/lib/recording/recording-recovery';
import { isStartRecordingResult, requireRuntimeMessageResult } from '@/lib/runtime/runtime-message-result';
import { isRestrictedUrl } from '@/lib/shared/restricted-urls';

interface Props {
  recording: RecordingState;
  onStarted?: () => void;
  onOpenEditor?: () => void | Promise<void>;
  openingEditor?: boolean;
  className?: string;
}

// Record keeps the mapping total: adding a RecordingMode member without copy
// is a compile error instead of a runtime crash on a failed lookup.
const MODE_DETAILS: Record<RecordingMode, { label: string; description: string }> = {
  steps: {
    label: '步驟',
    description: '每次點擊都會擷取一張截圖，自動編號成一連串教學步驟。',
  },
  snapshot: {
    label: '快照',
    description: '鎖定目前畫面，在同一張截圖上加入多個標註點。',
  },
};

const MODE_ORDER: readonly RecordingMode[] = ['steps', 'snapshot'];

export default function RecordControls({
  recording,
  onStarted,
  onOpenEditor,
  openingEditor = false,
  className,
}: Props) {
  const [mode, setMode] = useState<RecordingMode>('steps');
  const [crossPage, setCrossPage] = useState(false);
  const [pending, setPending] = useState(false);
  const [controlError, setControlError] = useState<string | null>(null);
  const [permissionNotice, setPermissionNotice] = useState<string | null>(null);
  const [restrictedPage, setRestrictedPage] = useState(false);

  useEffect(() => {
    let disposed = false;
    // Same check as start() and the background: extension pages (editor,
    // library, practice) genuinely cannot be recorded, so the pre-flight must
    // not enable a start button those layers will reject.
    void browser.tabs.query({ active: true, currentWindow: true })
      .then(([tab]) => {
        if (!disposed) setRestrictedPage(isRestrictedUrl(tab?.url));
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

  // The toggle mirrors the persisted <all_urls> grant: the background reads
  // host permissions directly, so starting `false` while the grant exists
  // would only make the control lie about what the next run can reach.
  useEffect(() => {
    let disposed = false;
    void (async () => {
      try {
        const granted = await browser.permissions.contains({ origins: ['<all_urls>'] });
        if (!disposed && granted) setCrossPage(true);
      } catch (error) {
        console.warn('讀取跨頁錄製權限失敗', error);
      }
    })();
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
      // The grant itself is what widens the run's reach; the background reads
      // host permissions directly, so no scope flag travels with the message.
      // Requesting resolves without a prompt when the grant already exists,
      // and it must be the first await here: Firefox only honours
      // permissions.request inside the direct user-input handler.
      if (crossPage) await requestCrossPagePermission();
      const [activeTab] = await browser.tabs.query({ active: true, currentWindow: true });
      if (isRestrictedUrl(activeTab?.url)) {
        setRestrictedPage(true);
        throw new Error('此頁面不允許錄製，請切換到要示範的一般網站分頁後再試一次。');
      }
      const guide = await ensureSelectedGuide();
      const result = requireRuntimeMessageResult<StartRecordingResult>(
        await browser.runtime.sendMessage({
          type: 'START_RECORDING',
          sessionId: guide.id,
          mode,
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
    setControlError(null);
    try {
      const tab = await browser.tabs.update(recording.tabId, { active: true });
      if (tab?.windowId != null) await browser.windows.update(tab.windowId, { focused: true });
      window.close();
    } catch (error) {
      console.error('回到錄製分頁失敗', error);
      setControlError('無法回到錄製分頁，分頁可能已關閉。');
    }
  }

  if (!recording.isRecording && needsEditorRecovery(recording.recoverableError)) {
    const editorFailed = recording.recoverableError?.code === 'EDITOR_OPEN_FAILED';
    return (
      <div className={cn('space-y-3', className)}>
        <Button
          className="h-10 w-full"
          disabled={openingEditor}
          onClick={() => void onOpenEditor?.()}
        >
          {openingEditor ? <Loader2 className="animate-spin" /> : <ExternalLink />}
          {openingEditor ? '正在開啟編輯器' : editorFailed ? '重試開啟編輯器' : '完成並開啟編輯器'}
        </Button>
      </div>
    );
  }

  // START_RECORDING is in flight. Falling through to the idle form here would
  // pair a 「準備中」 header with an enabled start button whose second click
  // fires a duplicate START_RECORDING.
  if (recording.phase === 'starting') {
    return (
      <div className={cn('flex flex-col gap-[18px]', className)}>
        <button
          type="button"
          disabled
          className="flex w-full items-center justify-center gap-[9px] rounded-md border-none bg-[var(--primary-raw)] py-[12px] text-[14px] font-medium text-[var(--primary-text-raw)] disabled:opacity-50"
        >
          <Loader2 className="size-4 animate-spin" />
          {recording.mode === 'snapshot' ? '正在建立乾淨底圖' : '正在連接頁面'}
        </button>
      </div>
    );
  }

  if (recording.isRecording && recording.runId) {
    const modeLabel = recording.mode === 'steps' ? '步驟' : '快照';
    const itemLabel = recording.mode === 'steps' ? '個步驟' : '個標註';
    return (
      <div className={cn('flex flex-col gap-4', className)}>
        {controlError && (
          <p role="alert" className="flex items-start gap-2 rounded-md bg-destructive/10 px-3 py-2 text-xs leading-[18px] text-destructive">
            <AlertCircle className="mt-0.5 size-4 shrink-0" />
            <span>{controlError}</span>
          </p>
        )}
        <div className="border-y border-border/80 py-3">
          <div className="flex items-center gap-2 text-[13px] font-semibold text-foreground">
            <span className="size-2 rounded-full bg-recording" />
            {recording.phase === 'paused' ? '已暫停' : modeLabel} · {recording.itemCount} {itemLabel}
          </div>
          <p className="mt-1.5 text-[11.5px] leading-[1.6] text-muted-foreground">
            錄製控制保留在原分頁右下角。
          </p>
        </div>
        <div className="flex flex-col gap-2">
          <button
            type="button"
            onClick={focusRecordedTab}
            className="flex h-11 w-full items-center justify-center gap-2 rounded-md border border-border/80 bg-card text-[13px] font-medium text-foreground hover:bg-secondary"
          >
            <ExternalLink className="size-4" />
            回到錄製分頁
          </button>
          {/* Secondary exit while a run is live (UX_PLAN 6.4): the editor shows
              what has been captured so far without interrupting the recording,
              which the page controller still owns. */}
          <button
            type="button"
            onClick={() => void onOpenEditor?.()}
            disabled={openingEditor || !onOpenEditor}
            className="flex h-9 w-full items-center justify-center gap-2 rounded-md text-[12.5px] font-medium text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground disabled:pointer-events-none disabled:opacity-50 dark:hover:bg-white/8 dark:hover:text-white"
          >
            {openingEditor ? <Loader2 className="size-[14px] animate-spin" /> : <PencilLine className="size-[14px]" />}
            {openingEditor ? '正在開啟編輯器' : '開啟編輯器'}
          </button>
        </div>
      </div>
    );
  }

  const activeMode = MODE_DETAILS[mode];

  return (
    <div className={cn('flex flex-col gap-[18px]', className)}>
      {permissionNotice && (
        <p role="status" className="flex items-start gap-2 rounded-md bg-amber-50 px-3 py-2 text-xs leading-[18px] text-amber-800 dark:bg-amber-950/30 dark:text-amber-200">
          <Info className="mt-0.5 size-4 shrink-0" />
          <span>{permissionNotice}</span>
        </p>
      )}
      {controlError && (
        <p role="alert" className="flex items-start gap-2 rounded-md bg-destructive/10 px-3 py-2 text-xs leading-[18px] text-destructive">
          <AlertCircle className="mt-0.5 size-4 shrink-0" />
          <span>{controlError}</span>
        </p>
      )}

      <div>
        <div role="radiogroup" aria-label="錄製模式" className="flex gap-[4px] rounded-md bg-secondary p-[4px]">
          {MODE_ORDER.map((candidate) => (
            <button
              key={candidate}
              type="button"
              role="radio"
              aria-checked={mode === candidate}
              onClick={() => setMode(candidate)}
              disabled={pending}
              className={cn(
                'flex-1 rounded-md py-[8px] text-center text-[13px] outline-none transition-all focus-visible:ring-2 focus-visible:ring-ring',
                // The selected chip stays a white pill in both themes — it is the
                // only selection indicator in this segmented control, so its text
                // colour is pinned to the light-theme ink rather than a token that
                // flips to lavender on a white background in dark mode.
                mode === candidate
                  ? 'bg-white font-bold text-[#1c1c1c] shadow-[0_2px_6px_rgba(28,28,28,0.12)] border border-black/5 dark:border-transparent dark:shadow-[0_2px_8px_rgba(255,255,255,0.25)]'
                  : 'font-medium text-foreground/50 hover:text-foreground dark:text-white/45 dark:hover:text-white',
              )}
            >
              {MODE_DETAILS[candidate].label}
            </button>
          ))}
        </div>
        <p className="mt-[10px] mx-[2px] mb-0 text-[11.5px] leading-[1.7] text-muted-foreground/80 dark:text-white/45">
          {activeMode.description}
        </p>
      </div>

      <div className="rounded-md border border-border/80 px-3 dark:border-white/10">
        <label className="flex min-h-11 items-center justify-between gap-3 py-2 text-xs font-medium text-foreground dark:text-white">
          <span className="min-w-0">
            <span className="block">跨頁錄製</span>
            <span className="block text-[11px] font-normal text-muted-foreground">需要時會要求網站存取權</span>
          </span>
          <Switch checked={crossPage} onCheckedChange={(checked) => void handleCrossPageChange(checked)} disabled={pending} />
        </label>
      </div>

      {restrictedPage && (
        <p role="status" className="text-xs leading-[18px] text-destructive">
          此頁面不允許錄製。請切換到要示範的一般網站分頁（http／https），再開始錄製。
        </p>
      )}

      <button
        type="button"
        onClick={start}
        disabled={pending || restrictedPage}
        className="flex w-full items-center justify-center gap-[9px] rounded-md border-none bg-[var(--primary-raw)] py-[12px] text-[14px] font-medium text-[var(--primary-text-raw)] hover:opacity-90 disabled:pointer-events-none disabled:opacity-50"
      >
        {pending ? (
          <Loader2 className="size-4 animate-spin" />
        ) : (
          <span className="size-[8px] rounded-full bg-recording/55" />
        )}
        {pending ? (mode === 'snapshot' ? '正在建立乾淨底圖' : '正在連接頁面') : '開始錄製'}
      </button>
    </div>
  );
}
