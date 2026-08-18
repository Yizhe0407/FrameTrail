import { useEffect, useState } from 'react';
import { browser } from 'wxt/browser';
import { ExternalLink, Loader2 } from 'lucide-react';
import InlineAlert from '@/components/shared/InlineAlert';
import OpenEditorButton from '@/components/popup/OpenEditorButton';
import { reportError } from '@/components/shared/report-error';
import { cn } from '@/lib/shared/utils';
import type { RecordingMode, RecordingState } from '@/lib/storage/recording-state';
import { startRecordingIntoNewGuide } from '@/lib/guide/guide-actions';
import {
  normalizeRecordingMode,
  recordingItemCountLabel,
  recordingModeCopy,
  RECORDING_MODE_COPY,
} from '@/lib/recording/recording-mode-copy';
import { needsEditorRecovery } from '@/lib/recording/recording-recovery';
import { focusTab } from '@/lib/runtime/navigation';
import { isRestrictedUrl } from '@/lib/shared/restricted-urls';
import {
  clearCrossTabRecordingDecline,
  hasDeclinedCrossTabRecording,
  markCrossTabRecordingDeclined,
} from '@/lib/runtime/cross-tab-recording';

interface Props {
  recording: RecordingState;
  onStarted?: () => void;
  onOpenEditor?: () => void | Promise<void>;
  openingEditor?: boolean;
  className?: string;
}

// Popup-only copy. The mode label and the item noun are shared with the
// recording toolbar and the editor stage, so they live in recording-mode-copy.
// Record keeps the mapping total: adding a RecordingMode member without copy
// is a compile error instead of a runtime crash on a failed lookup.
const MODE_DETAILS: Record<RecordingMode, {
  description: string;
  /** Button copy while START_RECORDING for this mode is in flight. */
  startingLabel: string;
}> = {
  steps: {
    description: '每次點擊都會擷取一張截圖，自動編號成一連串操作步驟。',
    startingLabel: '正在連接頁面',
  },
  snapshot: {
    description: '鎖定目前畫面，在同一張截圖上加入多個標註點。',
    startingLabel: '正在建立乾淨底圖',
  },
};

const MODE_ORDER: readonly RecordingMode[] = ['steps', 'snapshot'];

/** Where the one-time cross-tab (<all_urls>) ask stands. 'unknown' means the
 * mount probe has not resolved yet, so no hint may flash. */
type CrossTabPermission = 'unknown' | 'granted' | 'declined' | 'ungranted';

/**
 * The two facts the start handler must know synchronously before the click
 * (Firefox only honours permissions.request as the first await of a direct
 * user-input handler — no room to probe there), gathered by one mount probe:
 * whether the active tab is recordable at all, and where the cross-tab
 * permission stands.
 */
function useStartPreflight(onProbeError: (message: string) => void) {
  const [crossTab, setCrossTab] = useState<CrossTabPermission>('unknown');
  const [restrictedPage, setRestrictedPage] = useState(false);

  useEffect(() => {
    let disposed = false;

    // Same check as start() and the background: extension pages (editor,
    // library) genuinely cannot be recorded, so the pre-flight must
    // not enable a start button those layers will reject.
    void browser.tabs.query({ active: true, currentWindow: true })
      .then(([tab]) => {
        if (!disposed) setRestrictedPage(isRestrictedUrl(tab?.url));
      })
      .catch((error) => {
        console.error('[frametrail] failed to inspect the active tab', error);
        if (!disposed) {
          setRestrictedPage(true);
          onProbeError('無法讀取目前分頁，請重新開啟 FrameTrail 後再試一次。');
        }
      });

    void (async () => {
      try {
        const [granted, declined] = await Promise.all([
          browser.permissions.contains({ origins: ['<all_urls>'] }),
          hasDeclinedCrossTabRecording(),
        ]);
        if (!disposed) setCrossTab(granted ? 'granted' : declined ? 'declined' : 'ungranted');
      } catch (error) {
        console.warn('讀取跨分頁錄製權限失敗', error);
        if (!disposed) setCrossTab('ungranted');
      }
    })();

    return () => {
      disposed = true;
    };
    // `onProbeError` must be referentially stable (a setState) or the probe
    // re-runs on every render.
  }, [onProbeError]);

  return { crossTab, setCrossTab, restrictedPage, setRestrictedPage };
}

export default function RecordControls({
  recording,
  onStarted,
  onOpenEditor,
  openingEditor = false,
  className,
}: Props) {
  const [mode, setMode] = useState<RecordingMode>('steps');
  const [pending, setPending] = useState(false);
  const [controlError, setControlError] = useState<string | null>(null);
  const { crossTab, setCrossTab, restrictedPage, setRestrictedPage } = useStartPreflight(setControlError);

  /**
   * Must stay the first await of the calling user-input handler: Firefox only
   * honours permissions.request inside the direct handler. The decline flag is
   * persisted so an automatic ask happens at most once; a later grant clears
   * it so a revoked-then-reconsidered user gets the automatic ask again.
   */
  async function requestCrossTabPermission(): Promise<boolean> {
    try {
      const granted = await browser.permissions.request({ origins: ['<all_urls>'] });
      setCrossTab(granted ? 'granted' : 'declined');
      if (granted) await clearCrossTabRecordingDecline();
      else await markCrossTabRecordingDeclined();
      return granted;
    } catch (error) {
      console.warn('請求跨分頁錄製權限失敗', error);
      return false;
    }
  }

  async function start() {
    if (pending || restrictedPage) return;
    setPending(true);
    setControlError(null);
    try {
      // One-time ask at the first steps start: the grant itself is what widens
      // the run's reach (the background reads host permissions directly, so no
      // scope flag travels with the message). A decline is remembered and the
      // run simply continues single-tab. This must be the first await here —
      // see requestCrossTabPermission.
      if (mode === 'steps' && crossTab !== 'granted' && crossTab !== 'declined') {
        await requestCrossTabPermission();
      }
      const [activeTab] = await browser.tabs.query({ active: true, currentWindow: true });
      if (isRestrictedUrl(activeTab?.url)) {
        setRestrictedPage(true);
        throw new Error('此頁面不允許錄製，請切換到要示範的一般網站分頁後再試一次。');
      }
      await startRecordingIntoNewGuide(mode);
      onStarted?.();
    } catch (error) {
      setControlError(reportError('開始錄製失敗', error, '無法開始錄製，請重新整理頁面後再試一次。'));
    } finally {
      setPending(false);
    }
  }

  async function focusRecordedTab() {
    if (recording.tabId == null) return;
    setControlError(null);
    try {
      // RecordingState carries no windowId, so resolve it first — focusTab
      // only focuses the window when it is told which one.
      const tab = await browser.tabs.get(recording.tabId);
      await focusTab(recording.tabId, tab.windowId);
      window.close();
    } catch (error) {
      setControlError(reportError('回到錄製分頁失敗', error, '無法回到錄製分頁，分頁可能已關閉。'));
    }
  }

  if (!recording.isRecording && needsEditorRecovery(recording.recoverableError)) {
    const editorFailed = recording.recoverableError?.code === 'EDITOR_OPEN_FAILED';
    return (
      <div className={cn('space-y-3', className)}>
        <OpenEditorButton
          label={editorFailed ? '重試開啟編輯器' : '完成並開啟編輯器'}
          pending={openingEditor}
          onOpen={onOpenEditor}
          className="flex h-10 w-full cursor-pointer items-center justify-center gap-2 rounded-md bg-primary text-sm font-medium text-primary-foreground transition-all hover:bg-primary/90 disabled:pointer-events-none disabled:opacity-50"
          iconClassName="size-4"
        />
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
          {MODE_DETAILS[normalizeRecordingMode(recording.mode)].startingLabel}
        </button>
      </div>
    );
  }

  if (recording.isRecording && recording.runId) {
    return (
      <div className={cn('flex flex-col gap-4', className)}>
        {controlError && <InlineAlert>{controlError}</InlineAlert>}
        <div className="border-y border-border/80 py-3">
          <div className="flex items-center gap-2 text-[13px] font-semibold text-foreground">
            <span className="size-2 rounded-full bg-recording" />
            {recording.phase === 'paused' ? '已暫停' : recordingModeCopy(recording.mode).label}
            {' · '}
            {recordingItemCountLabel(recording.mode, recording.itemCount)}
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
          <OpenEditorButton
            label="開啟編輯器"
            pending={openingEditor}
            onOpen={onOpenEditor}
            className="flex h-9 w-full items-center justify-center gap-2 rounded-md text-[12.5px] font-medium text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground disabled:pointer-events-none disabled:opacity-50 dark:hover:bg-white/8 dark:hover:text-white"
            iconClassName="size-[14px]"
          />
        </div>
      </div>
    );
  }

  const activeMode = MODE_DETAILS[mode];

  return (
    <div className={cn('flex flex-col gap-[18px]', className)}>
      {controlError && <InlineAlert>{controlError}</InlineAlert>}

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
              {RECORDING_MODE_COPY[candidate].label}
            </button>
          ))}
        </div>
        <p className="mt-[10px] mx-[2px] mb-0 text-[11.5px] leading-[1.7] text-muted-foreground/80 dark:text-white/45">
          {activeMode.description}
        </p>
        {/* Passive affordance, never a nag: shown whenever the grant is absent
            (even after a remembered decline), and the request runs directly in
            the click handler so the browser accepts it as a user gesture. */}
        {mode === 'steps' && (crossTab === 'declined' || crossTab === 'ungranted') && (
          <p className="mt-[6px] mx-[2px] mb-0 text-[11px] leading-[1.7] text-muted-foreground/60 dark:text-white/35">
            目前僅錄製單一分頁。
            <button
              type="button"
              onClick={() => void requestCrossTabPermission()}
              disabled={pending}
              className="ml-[2px] rounded-sm underline underline-offset-2 outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none dark:hover:text-white"
            >
              啟用跨分頁錄製
            </button>
          </p>
        )}
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
        {pending ? MODE_DETAILS[mode].startingLabel : '開始錄製'}
      </button>
    </div>
  );
}
