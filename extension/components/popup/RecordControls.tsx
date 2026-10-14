import { useEffect, useState } from 'react';
import { browser } from 'wxt/browser';
import { Camera, ExternalLink, ListOrdered, Loader2, TriangleAlert } from 'lucide-react';
import { buttonVariants } from '@/components/ui/button';
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
import { claimPendingStart, discardPendingStart, parkPendingStart } from '@/lib/runtime/pending-start';

interface Props {
  recording: RecordingState;
  onStarted?: () => void;
  onOpenEditor?: () => void | Promise<void>;
  openingEditor?: boolean;
  className?: string;
}

// Popup-only copy; the label/noun are shared elsewhere via recording-mode-copy.
// The Record type keeps the mapping total, so a missing RecordingMode key is
// a compile error rather than a runtime lookup failure.
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

const MODE_ICONS: Record<RecordingMode, typeof Camera> = {
  steps: ListOrdered,
  snapshot: Camera,
};

/** The record action is the popup's one red sticker; every state of it (idle,
 * starting, editor recovery) shares this shape so the button never jumps. */
const RECORD_BUTTON_CLASS =
  'flex h-12 w-full cursor-pointer items-center justify-center gap-2.5 rounded-md border-2 border-border bg-recording text-base font-bold text-recording-foreground outline-none transition-colors focus-ring hover:bg-recording-hover active:translate-y-px disabled:pointer-events-none disabled:opacity-50';

/** Where the one-time cross-tab (<all_urls>) ask stands. 'unknown' means the
 * mount probe has not resolved yet, so no hint may flash. */
type CrossTabPermission = 'unknown' | 'granted' | 'declined' | 'ungranted';

/**
 * Gathers, via one mount probe, the two facts the start handler needs
 * synchronously before the click: whether the tab is recordable, and where
 * cross-tab permission stands. (Firefox only honours permissions.request as
 * the first await of a direct user-input handler, so there's no room to probe there.)
 */
function useStartPreflight(onProbeError: (message: string) => void) {
  const [crossTab, setCrossTab] = useState<CrossTabPermission>('unknown');
  const [restrictedPage, setRestrictedPage] = useState(false);
  const [activeTabId, setActiveTabId] = useState<number | null>(null);

  useEffect(() => {
    let disposed = false;

    // Same check as start() and the background: extension pages (editor,
    // library) genuinely cannot be recorded, so the pre-flight must
    // not enable a start button those layers will reject.
    void browser.tabs.query({ active: true, currentWindow: true })
      .then(([tab]) => {
        if (disposed) return;
        setRestrictedPage(isRestrictedUrl(tab?.url));
        setActiveTabId(tab?.id != null && !isRestrictedUrl(tab.url) ? tab.id : null);
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

  return { crossTab, setCrossTab, restrictedPage, setRestrictedPage, activeTabId };
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
  const { crossTab, setCrossTab, restrictedPage, setRestrictedPage, activeTabId } = useStartPreflight(setControlError);

  /**
   * Must stay the first await in the handler: Firefox only honours
   * permissions.request there. The decline is persisted so the auto-ask fires
   * once; a later grant clears it so a reconsidered user gets asked again.
   */
  async function requestCrossTabPermission(
    resumeStart?: { mode: RecordingMode; tabId: number },
  ): Promise<{ granted: boolean; parked: boolean }> {
    try {
      // Not awaited: Firefox needs permissions.request to run synchronously within the click.
      const parking = resumeStart
        ? Promise.all([
            parkPendingStart(resumeStart.mode, resumeStart.tabId),
            markCrossTabRecordingDeclined(),
          ]).then(() => true, (error) => {
            console.warn('暫存開始錄製請求失敗', error);
            return false;
          })
        : Promise.resolve(false);
      const granted = await browser.permissions.request({ origins: ['<all_urls>'] });
      const parked = await parking;
      setCrossTab(granted ? 'granted' : 'declined');
      if (granted) await clearCrossTabRecordingDecline();
      else await markCrossTabRecordingDeclined();
      return { granted, parked };
    } catch (error) {
      console.warn('請求跨分頁錄製權限失敗', error);
      return { granted: false, parked: false };
    }
  }

  async function start() {
    if (pending || restrictedPage) return;
    setPending(true);
    setControlError(null);
    try {
      // One-time ask at first steps start: the grant itself widens the run's
      // reach (background reads host permissions directly). A decline just
      // continues single-tab. Must be the first await here — see requestCrossTabPermission.
      if (mode === 'steps' && crossTab !== 'granted' && crossTab !== 'declined') {
        const { granted, parked } = await requestCrossTabPermission(
          activeTabId != null ? { mode, tabId: activeTabId } : undefined,
        );
        if (granted && parked && !(await claimPendingStart())) {
          onStarted?.();
          return;
        }
        if (!granted) await discardPendingStart();
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
          className={cn(buttonVariants({ size: 'lg' }), 'w-full')}
        />
      </div>
    );
  }

  // START_RECORDING is in flight. Falling through to the idle form here would
  // pair a 「準備中」 header with an enabled start button whose second click
  // fires a duplicate START_RECORDING.
  if (recording.phase === 'starting') {
    return (
      <div className={cn('flex flex-col gap-4', className)}>
        <button type="button" disabled className={RECORD_BUTTON_CLASS}>
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
        <div className="rounded-md border-2 border-border bg-surface-raised px-3.5 py-3">
          <div className="flex items-center gap-2 text-sm font-bold text-foreground">
            <span className="size-2 rounded-full bg-recording" />
            {recording.phase === 'paused' ? '已暫停' : recordingModeCopy(recording.mode).label}
            {' · '}
            {recordingItemCountLabel(recording.mode, recording.itemCount)}
          </div>
          <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
            錄製控制保留在原分頁右下角。
          </p>
        </div>
        <div className="flex flex-col gap-2">
          <button
            type="button"
            onClick={focusRecordedTab}
            className={cn(buttonVariants(), 'w-full')}
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
            className={cn(buttonVariants({ variant: 'ghost', size: 'sm' }), 'w-full')}
          />
        </div>
      </div>
    );
  }

  const activeMode = MODE_DETAILS[mode];

  return (
    <div className={cn('flex flex-col gap-4', className)}>
      {controlError && <InlineAlert>{controlError}</InlineAlert>}

      <div className="flex flex-col gap-2.5">
        {/* 2px outline + 2px padding puts each option exactly 4px inside, the
            inset the concentric `rounded-sm` radius is drawn for. */}
        <div role="radiogroup" aria-label="錄製模式" className="flex gap-0.5 rounded-md border-2 border-border bg-secondary p-0.5">
          {MODE_ORDER.map((candidate) => {
            const Icon = MODE_ICONS[candidate];
            return (
              <button
                key={candidate}
                type="button"
                role="radio"
                aria-checked={mode === candidate}
                onClick={() => setMode(candidate)}
                disabled={pending}
                className={cn(
                  'flex h-9 flex-1 items-center justify-center gap-1.5 rounded-sm border-2 text-sm font-bold outline-none transition-colors focus-ring',
                  // Pastel fill + ink text in both themes, like every selection.
                  mode === candidate
                    ? 'border-border bg-selected text-on-accent'
                    : 'border-transparent text-muted-foreground hover:text-foreground',
                )}
              >
                <Icon className="size-4" aria-hidden="true" />
                {RECORDING_MODE_COPY[candidate].label}
              </button>
            );
          })}
        </div>
        <p className="rounded-md border-2 border-dashed border-border-soft px-3 py-2.5 text-[13px] leading-relaxed text-muted-foreground">
          {activeMode.description}
        </p>
        {/* Passive affordance, never a nag: shown whenever the grant is absent
            (even after a remembered decline), and the request runs directly in
            the click handler so the browser accepts it as a user gesture. */}
        {mode === 'steps' && (crossTab === 'declined' || crossTab === 'ungranted') && (
          <p className="px-0.5 text-xs leading-relaxed text-muted-foreground">
            目前僅錄製單一分頁。
            <button
              type="button"
              onClick={() => void requestCrossTabPermission()}
              disabled={pending}
              className="ml-0.5 rounded-sm font-bold text-brand-text underline underline-offset-2 outline-none focus-ring disabled:pointer-events-none"
            >
              啟用跨分頁錄製
            </button>
          </p>
        )}
      </div>

      {/* Says why the button is off and what to do instead, so the disabled
          primary action is never a dead end. */}
      {restrictedPage && (
        <p role="status" className="flex items-start gap-2 rounded-md border-2 border-border bg-warning-soft px-3 py-2.5 text-xs leading-relaxed text-foreground">
          <TriangleAlert className="mt-px size-4 shrink-0" aria-hidden="true" />
          <span>這個頁面無法錄製。請切換到要示範的一般網頁分頁，再開啟 FrameTrail。</span>
        </p>
      )}

      <button
        type="button"
        onClick={start}
        disabled={pending || restrictedPage}
        // A blocked page greys the sticker out entirely; a dimmed red would
        // still read as "ready to record".
        className={cn(
          RECORD_BUTTON_CLASS,
          restrictedPage && 'border-border-soft bg-secondary text-muted-foreground disabled:opacity-100',
        )}
      >
        {pending ? (
          <Loader2 className="size-4 animate-spin" />
        ) : (
          <span className="size-3 rounded-full border-2 border-current bg-current/40" aria-hidden="true" />
        )}
        {pending ? MODE_DETAILS[mode].startingLabel : '開始錄製'}
      </button>
    </div>
  );
}
