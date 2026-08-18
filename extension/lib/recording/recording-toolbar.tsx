import {
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import {
  Check,
  Crop,
  Expand,
  Loader2,
  Minimize2,
  Pause,
  Play,
  Plus,
  Shrink,
  Trash2,
  TriangleAlert,
  Undo2,
} from 'lucide-react';
import type { RecordingControlMessage, RecordingControlResult } from '@/lib/runtime/messages';
import type { RecordingMode, RecordingPhase } from '@/lib/storage/recording-state';
import { cycleActionLabel } from '@/lib/capture/candidate-cycling';
import { recordingModeCopy } from './recording-mode-copy';
import { RECORDING_CHANNEL_LOST_MESSAGE } from './content-script-constants';
import { recordingToolbarStyles } from './recording-toolbar-styles';
import { useToolbarPosition } from './use-toolbar-position';
import { isRecordingControlResult, requireRuntimeMessageResult } from '@/lib/runtime/runtime-message-result';

type ToolbarAction = RecordingControlMessage['type'];

export interface RecordingToolbarState {
  runId: string;
  mode: RecordingMode;
  phase: RecordingPhase;
  itemCount: number;
  error: string | null;
}

interface Props {
  state: RecordingToolbarState;
  onCommand: (action: ToolbarAction, undoToken?: string) => Promise<RecordingControlResult>;
  onUndoApplied?: () => void;
  onRestoreApplied?: () => void;
  onStartRegionCapture?: () => void;
  regionCaptureActive?: boolean;
  /** Selection-resize controls for the hovered point, or null when it offers
   * no other box. They live inside the toolbar so the affordance can never
   * cover page content. */
  candidateCycling?: CandidateCyclingControls | null;
}

export interface CandidateCyclingControls {
  canWiden: boolean;
  canNarrow: boolean;
  onAdjust(delta: number): void;
}

export default function RecordingToolbar({
  state,
  onCommand,
  onUndoApplied,
  onRestoreApplied,
  onStartRegionCapture,
  regionCaptureActive = false,
  candidateCycling = null,
}: Props) {
  const [collapsed, setCollapsed] = useState(false);
  const [pending, setPending] = useState<ToolbarAction | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const [undo, setUndo] = useState<{ token: string; itemNumber: number } | null>(null);
  const [showSuccess, setShowSuccess] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const previousCount = useRef(state.itemCount);
  const pendingRef = useRef<ToolbarAction | null>(null);
  const floatingRef = useRef<HTMLElement | null>(null);
  const cancelDiscardRef = useRef<HTMLButtonElement | null>(null);
  const confirmTitleId = useId();
  const confirmDescriptionId = useId();
  const modeCopy = recordingModeCopy(state.mode);

  const {
    corner,
    position,
    suppressNextClick,
    handlePositionPointerDown,
    handlePositionPointerMove,
    finishPositionDrag,
    handlePositionKeyDown,
  } = useToolbarPosition({
    floatingRef,
    // The floating element remounts when collapse toggles and resizes when the
    // phase switches layouts, so both feed the reposition/observer pass.
    layoutKey: `${collapsed}:${state.phase}`,
    isInteractionBlocked: () => pendingRef.current !== null,
    announce: setAnnouncement,
  });

  useEffect(() => {
    if (confirmDiscard) cancelDiscardRef.current?.focus();
  }, [confirmDiscard]);

  useEffect(() => {
    if (state.itemCount > previousCount.current) {
      const noun = recordingModeCopy(state.mode).itemNoun;
      setAnnouncement(`已${state.mode === 'steps' ? '建立' : '加入'}${noun} ${state.itemCount}`);
      setShowSuccess(true);
      const timer = window.setTimeout(() => setShowSuccess(false), 800);
      previousCount.current = state.itemCount;
      return () => window.clearTimeout(timer);
    }
    previousCount.current = state.itemCount;
    return undefined;
  }, [state.itemCount, state.mode]);

  useEffect(() => {
    if (regionCaptureActive) setAnnouncement('區域擷取已啟動，請在畫面上拖曳選取範圍');
  }, [regionCaptureActive]);

  useEffect(() => {
    if (!undo) return;
    const timer = window.setTimeout(() => setUndo(null), 5_000);
    return () => window.clearTimeout(timer);
  }, [undo]);

  async function run(action: ToolbarAction, token?: string): Promise<RecordingControlResult> {
    if (pendingRef.current) return { ok: false, error: '另一個動作仍在處理中。' };
    pendingRef.current = action;
    setPending(action);
    setMessage(null);
    try {
      const result = requireRuntimeMessageResult<RecordingControlResult>(
        await onCommand(action, token),
        isRecordingControlResult,
        RECORDING_CHANNEL_LOST_MESSAGE,
      );
      if (!result.ok) setMessage(result.error);
      return result;
    } catch (error) {
      // Inline copy of components/shared reportError — the toolbar lives in
      // lib/, which must not depend upward on components/.
      console.error('[frametrail] recording toolbar command failed', error);
      const result = {
        ok: false,
        error: error instanceof Error && error.message ? error.message : '動作失敗，請再試一次。',
      } as const;
      setMessage(result.error);
      return result;
    } finally {
      pendingRef.current = null;
      setPending(null);
    }
  }

  async function handleUndo() {
    const result = await run('UNDO_LAST_CAPTURE');
    if (!result.ok || !result.undoToken || !result.removedItemNumber) return;
    onUndoApplied?.();
    setUndo({ token: result.undoToken, itemNumber: result.removedItemNumber });
    setAnnouncement(`已移除${modeCopy.itemNoun} ${result.removedItemNumber}`);
  }

  async function handleRestore() {
    if (!undo) return;
    const result = await run('RESTORE_LAST_CAPTURE', undo.token);
    if (!result.ok) return;
    onRestoreApplied?.();
    setUndo(null);
    setAnnouncement('已還原');
  }

  const handleDiscard = async () => {
    const result = await run('DISCARD_CURRENT_RECORDING');
    if (result.ok) setConfirmDiscard(false);
  };

  const handleConfirmKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Tab') return;
    const controls = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'));
    if (controls.length === 0) return;
    const first = controls[0];
    const last = controls.at(-1)!;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  const paused = state.phase === 'paused';
  const preparingNext = state.mode === 'snapshot' && state.phase === 'preparing-next';
  const invalidated = state.mode === 'snapshot' && state.phase === 'invalidated';
  const busy = pending !== null || state.phase === 'finishing';

  useEffect(() => {
    if (!invalidated) return;
    setCollapsed(false);
    setUndo(null);
  }, [invalidated]);

  if (state.phase === 'starting') return null;

  return (
    <>
      <style>{recordingToolbarStyles}</style>
      <div
        className="ft-layer"
        onKeyDown={(event) => {
          if (event.key !== 'Escape' || pendingRef.current) return;
          setConfirmDiscard(false);
        }}
      >
        {confirmDiscard && (
          <div
            className="ft-modal-backdrop"
            aria-hidden="true"
            onPointerDown={() => {
              if (!pendingRef.current) setConfirmDiscard(false);
            }}
          />
        )}
        <div
          className="ft-position"
          data-horizontal={corner.endsWith('left') ? 'left' : 'right'}
          data-vertical={corner.startsWith('top') ? 'top' : 'bottom'}
          style={position ? { transform: `translate3d(${position.x}px, ${position.y}px, 0)` } : undefined}
        >
          {(message || (state.error && !invalidated)) && (
            <div className="ft-message" data-kind="error" role="alert">
              {message ?? state.error}
            </div>
          )}
          {!message && !state.error && showSuccess && (
            <div className="ft-message" role="status"><Check className="ft-success" />已記錄</div>
          )}
          {undo && (
            <div className="ft-snackbar" role="status">
              <span>已移除{modeCopy.itemNoun} {undo.itemNumber}</span>
              <button type="button" onClick={handleRestore} disabled={busy}>還原</button>
            </div>
          )}
          {confirmDiscard && (
            <div
              className="ft-confirm"
              role="alertdialog"
              aria-modal="true"
              aria-labelledby={confirmTitleId}
              aria-describedby={confirmDescriptionId}
              onKeyDown={handleConfirmKeyDown}
            >
              <h2 className="ft-confirm-title" id={confirmTitleId}>放棄這次錄製？</h2>
              <p className="ft-confirm-copy" id={confirmDescriptionId}>
                這次新增的內容會被移除，先前已完成的內容不受影響。
              </p>
              <div className="ft-confirm-actions">
                <button
                  ref={cancelDiscardRef}
                  type="button"
                  disabled={pending === 'DISCARD_CURRENT_RECORDING'}
                  onClick={() => setConfirmDiscard(false)}
                >
                  取消
                </button>
                <button
                  type="button"
                  data-danger="true"
                  disabled={pending === 'DISCARD_CURRENT_RECORDING'}
                  onClick={() => void handleDiscard()}
                >
                  {pending === 'DISCARD_CURRENT_RECORDING' ? '處理中' : '放棄錄製'}
                </button>
              </div>
            </div>
          )}

          {collapsed && !invalidated ? (
            <button
              ref={(element) => { floatingRef.current = element; }}
              type="button"
              className="ft-collapsed"
              data-frametrail-toolbar-position=""
              aria-label={`${paused ? '已暫停' : '錄製中'}，${modeCopy.label}，${state.itemCount} 筆；展開錄製控制`}
              title="展開控制器"
              onPointerDown={handlePositionPointerDown}
              onPointerMove={handlePositionPointerMove}
              onPointerUp={finishPositionDrag}
              onPointerCancel={finishPositionDrag}
              onKeyDown={handlePositionKeyDown}
              onClick={() => {
                if (suppressNextClick.current) {
                  suppressNextClick.current = false;
                  return;
                }
                setCollapsed(false);
              }}
            >
              <span className="ft-dot" aria-hidden="true" />
              <span className="ft-count-badge" style={{ minWidth: '22px', height: '22px', fontSize: '12px' }}>{state.itemCount}</span>
              <span className="ft-collapsed-expand">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/></svg>
              </span>
            </button>
          ) : (
            <div
              ref={(element) => { floatingRef.current = element; }}
              className={`ft-toolbar${invalidated ? ' ft-toolbar--invalidated' : ''}`}
              role="toolbar"
              aria-label="錄製控制"
            >
              {invalidated ? (
                <>
                  <div className="ft-invalidated-status" role="status">
                    <TriangleAlert aria-hidden="true" />
                    <span className="ft-invalidated-copy">畫面尺寸已改變，需建立新快照才能繼續。</span>
                  </div>
                  <div className="ft-invalidated-actions">
                    {/* The invalidated shell has no collapse control (collapsing
                        would hide the only way out of the dead run), so discard
                        sits directly in the row instead of behind a menu whose
                        only item it was. */}
                    <button
                      type="button"
                      className="ft-button"
                      data-danger="true"
                      aria-label="放棄這次錄製"
                      title="放棄這次錄製"
                      disabled={busy}
                      onClick={() => setConfirmDiscard(true)}
                    >
                      <Trash2 size={17} />
                    </button>
                    <button
                      type="button"
                      className="ft-secondary"
                      disabled={busy}
                      onClick={() => void run('FINISH_RECORDING')}
                    >
                      {pending === 'FINISH_RECORDING' ? '整理中' : '完成錄製'}
                    </button>
                    <button
                      type="button"
                      className="ft-finish"
                      disabled={busy}
                      onClick={() => void run('REBUILD_INVALIDATED_SNAPSHOT')}
                    >
                      {pending === 'REBUILD_INVALIDATED_SNAPSHOT' ? <Loader2 /> : <Plus />}
                      {pending === 'REBUILD_INVALIDATED_SNAPSHOT' ? '重建中' : '保留並重建'}
                    </button>
                  </div>
                </>
              ) : (
                <>
                  <button
                    type="button"
                    className="ft-status"
                    data-frametrail-toolbar-position=""
                    aria-label={`${preparingNext ? '下一張尚未建立' : `${paused ? '已暫停' : '錄製中'}，${modeCopy.label}，${state.itemCount} 筆`}；拖曳或使用方向鍵移動`}
                    title="拖曳或使用方向鍵移動錄製控制"
                    onPointerDown={handlePositionPointerDown}
                    onPointerMove={handlePositionPointerMove}
                    onPointerUp={finishPositionDrag}
                    onPointerCancel={finishPositionDrag}
                    onKeyDown={handlePositionKeyDown}
                  >
                    <span className="ft-dot" aria-hidden="true" />
                    <span className="ft-status-text">
                      {regionCaptureActive
                        ? '區域擷取中'
                        : preparingNext ? '下一張尚未建立' : '已擷取'}
                    </span>
                    <span className="ft-count-badge">{state.itemCount}</span>
                  </button>

                  {candidateCycling && !regionCaptureActive && (
                    <div className="ft-actions-group" role="group" aria-label="選取範圍">
                      {([
                        { direction: 'narrow', delta: -1, enabled: candidateCycling.canNarrow, Icon: Shrink },
                        { direction: 'widen', delta: 1, enabled: candidateCycling.canWiden, Icon: Expand },
                      ] as const).map(({ direction, delta, enabled, Icon }) => {
                        const label = cycleActionLabel(direction);
                        return (
                          <button
                            key={direction}
                            type="button"
                            className="ft-button"
                            aria-label={label}
                            title={label}
                            disabled={busy || !enabled}
                            onClick={() => candidateCycling.onAdjust(delta)}
                          >
                            <Icon size={18} />
                          </button>
                        );
                      })}
                    </div>
                  )}

                  <span className="ft-divider" aria-hidden="true" />

                  <div className="ft-actions-group">
                    {!preparingNext && (
                      <button
                        type="button"
                        className="ft-button"
                        aria-label="復原上一個"
                        title="復原上一步"
                        disabled={busy || state.itemCount === 0}
                        onClick={handleUndo}
                      >
                        {pending === 'UNDO_LAST_CAPTURE' ? <Loader2 /> : <Undo2 size={18} />}
                      </button>
                    )}
                    {!preparingNext && onStartRegionCapture && (
                      <button
                        type="button"
                        className="ft-button"
                        aria-label={regionCaptureActive ? '區域擷取進行中' : '裁切擷取區域'}
                        title={regionCaptureActive ? '區域擷取進行中' : '裁切擷取區域'}
                        aria-pressed={regionCaptureActive}
                        disabled={busy || paused || regionCaptureActive || state.phase !== 'recording'}
                        onClick={() => onStartRegionCapture()}
                      >
                        <Crop size={17} />
                      </button>
                    )}
                    {state.mode === 'steps' && !preparingNext && (
                      <button
                        type="button"
                        className="ft-button"
                        aria-label={paused ? '繼續錄製' : '暫停錄製'}
                        title={paused ? '繼續錄製' : '暫停錄製'}
                        disabled={busy}
                        onClick={() => void run(paused ? 'RESUME_RECORDING' : 'PAUSE_RECORDING')}
                      >
                        {pending === 'PAUSE_RECORDING' || pending === 'RESUME_RECORDING'
                          ? <Loader2 />
                          : paused ? <Play size={16} /> : <Pause size={16} />}
                      </button>
                    )}
                    {state.mode === 'snapshot' && !preparingNext && (
                      <button
                        type="button"
                        className="ft-button"
                        aria-label="完成並新增快照"
                        title="完成並新增快照"
                        disabled={busy}
                        onClick={() => void run('PREPARE_NEXT_SNAPSHOT')}
                      >
                        {pending === 'PREPARE_NEXT_SNAPSHOT' ? <Loader2 /> : <Plus size={17} />}
                      </button>
                    )}
                    <button
                      type="button"
                      className="ft-button"
                      data-danger="true"
                      aria-label="放棄這次錄製"
                      title="放棄這次錄製"
                      disabled={busy}
                      onClick={() => setConfirmDiscard(true)}
                    >
                      <Trash2 size={17} />
                    </button>
                    <button
                      type="button"
                      className="ft-button"
                      aria-label="收合控制器"
                      title="收合控制器"
                      disabled={busy}
                      onClick={() => setCollapsed(true)}
                    >
                      <Minimize2 size={17} />
                    </button>
                  </div>

                  <button
                    type="button"
                    className="ft-finish"
                    disabled={busy}
                    onClick={() => void run(preparingNext ? 'CREATE_NEXT_SNAPSHOT' : 'FINISH_RECORDING')}
                  >
                    {pending === 'FINISH_RECORDING' || pending === 'CREATE_NEXT_SNAPSHOT' || state.phase === 'finishing'
                      ? <Loader2 />
                      : preparingNext ? '建立新快照' : '完成'}
                  </button>
                </>
              )}
            </div>
          )}
        </div>
        <div className="ft-sr-only" aria-live="polite" aria-atomic="true">{announcement}</div>
      </div>
    </>
  );
}
