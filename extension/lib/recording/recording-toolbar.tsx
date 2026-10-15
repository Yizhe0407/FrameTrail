import {
  useEffect,
  useLayoutEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import {
  Check,
  Crop,
  Loader2,
  Minimize2,
  Pause,
  Play,
  Plus,
  Trash2,
  TriangleAlert,
  Undo2,
} from 'lucide-react';
import type { RecordingControlMessage, RecordingControlResult } from '@/lib/runtime/messages';
import type { RecordingMode, RecordingPhase } from '@/lib/storage/recording-state';
import { recordingModeCopy } from './recording-mode-copy';

import { recordingToolbarStyles } from './recording-toolbar-styles';
import { useToolbarPosition } from './use-toolbar-position';
import { isRecordingControlResult, requireRuntimeMessageResult } from '@/lib/runtime/runtime-message-result';
import { t, useActiveLocale } from '@/lib/shared/i18n';

type ToolbarAction = RecordingControlMessage['type'];

const MODE_OPTIONS: readonly RecordingMode[] = ['steps', 'snapshot'];

const modeSwitchAction = (target: RecordingMode): ToolbarAction =>
  target === 'snapshot' ? 'SWITCH_TO_SNAPSHOT_MODE' : 'SWITCH_TO_STEPS_MODE';

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
}

export default function RecordingToolbar({
  state,
  onCommand,
  onUndoApplied,
  onRestoreApplied,
  onStartRegionCapture,
  regionCaptureActive = false,
}: Props) {
  useActiveLocale();
  const [collapsed, setCollapsed] = useState(false);
  const [pending, setPending] = useState<ToolbarAction | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const [undo, setUndo] = useState<{ token: string; itemNumber: number } | null>(null);
  const [showSuccess, setShowSuccess] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [confirmSwitch, setConfirmSwitch] = useState(false);
  const previousCount = useRef(state.itemCount);
  const pendingRef = useRef<ToolbarAction | null>(null);
  const floatingRef = useRef<HTMLElement | null>(null);
  const cancelDiscardRef = useRef<HTMLButtonElement | null>(null);
  const cancelSwitchRef = useRef<HTMLButtonElement | null>(null);
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
    if (confirmSwitch) cancelSwitchRef.current?.focus();
  }, [confirmSwitch]);

  useEffect(() => {
    if (state.itemCount > previousCount.current) {
      setAnnouncement(recordingModeCopy(state.mode).itemAdded(state.itemCount));
      setShowSuccess(true);
      const timer = window.setTimeout(() => setShowSuccess(false), 800);
      previousCount.current = state.itemCount;
      return () => window.clearTimeout(timer);
    }
    previousCount.current = state.itemCount;
    return undefined;
  }, [state.itemCount, state.mode]);

  useEffect(() => {
    if (regionCaptureActive) setAnnouncement(t().toolbar.regionCaptureStarted);
  }, [regionCaptureActive]);

  useEffect(() => {
    if (!undo) return;
    const timer = window.setTimeout(() => setUndo(null), 5_000);
    return () => window.clearTimeout(timer);
  }, [undo]);

  async function run(action: ToolbarAction, token?: string): Promise<RecordingControlResult> {
    if (pendingRef.current) return { ok: false, error: t().toolbar.busy };
    pendingRef.current = action;
    setPending(action);
    setMessage(null);
    try {
      const result = requireRuntimeMessageResult<RecordingControlResult>(
        await onCommand(action, token),
        isRecordingControlResult,
        t().runtime.recordingChannelLost,
      );
      if (!result.ok) setMessage(result.error);
      return result;
    } catch (error) {
      // Inline copy of components/shared reportError — the toolbar lives in
      // lib/, which must not depend upward on components/.
      console.error('[frametrail] recording toolbar command failed', error);
      const result = {
        ok: false,
        error: error instanceof Error && error.message ? error.message : t().toolbar.actionFailed,
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
    setAnnouncement(modeCopy.itemRemoved(result.removedItemNumber));
  }

  async function handleRestore() {
    if (!undo) return;
    const result = await run('RESTORE_LAST_CAPTURE', undo.token);
    if (!result.ok) return;
    onRestoreApplied?.();
    setUndo(null);
    setAnnouncement(t().toolbar.restored);
  }

  const handleDiscard = async () => {
    const result = await run('DISCARD_CURRENT_RECORDING');
    if (result.ok) setConfirmDiscard(false);
  };

  const handleSwitchMode = (target: RecordingMode) => {
    if (target === state.mode) return;
    if (target === 'snapshot') {
      void run('SWITCH_TO_SNAPSHOT_MODE');
    } else if (state.phase === 'recording' && state.itemCount > 0) {
      setConfirmSwitch(true);
    } else {
      void run('SWITCH_TO_STEPS_MODE');
    }
  };

  const handleConfirmSwitch = async (action: ToolbarAction) => {
    const result = await run(action);
    if (result.ok) setConfirmSwitch(false);
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

  // Stack the toolbar only when its single row would not fit. Measured after
  // every render, before paint, so it follows the real labels (any language,
  // mode or phase) and the viewport rather than a hard-coded breakpoint.
  useLayoutEffect(() => {
    const toolbar = floatingRef.current;
    if (!toolbar?.classList.contains('ft-toolbar')) return;
    const fit = () => {
      toolbar.removeAttribute('data-compact');
      if (toolbar.scrollWidth > toolbar.clientWidth + 1) toolbar.setAttribute('data-compact', '');
    };
    fit();
    window.addEventListener('resize', fit);
    return () => window.removeEventListener('resize', fit);
  });

  const paused = state.phase === 'paused';
  const statusLabel = t().toolbar.status(paused, modeCopy.label, state.itemCount);
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
          setConfirmSwitch(false);
        }}
      >
        {(confirmDiscard || confirmSwitch) && (
          <div
            className="ft-modal-backdrop"
            aria-hidden="true"
            onPointerDown={() => {
              if (pendingRef.current) return;
              setConfirmDiscard(false);
              setConfirmSwitch(false);
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
            <div className="ft-message" role="status"><Check className="ft-success" />{t().toolbar.recorded}</div>
          )}
          {undo && (
            <div className="ft-snackbar" role="status">
              <span>{modeCopy.itemRemoved(undo.itemNumber)}</span>
              <button type="button" onClick={handleRestore} disabled={busy}>{t().common.restore}</button>
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
              <h2 className="ft-confirm-title" id={confirmTitleId}>{t().toolbar.discardTitle}</h2>
              <p className="ft-confirm-copy" id={confirmDescriptionId}>
                {t().toolbar.discardBody}
              </p>
              <div className="ft-confirm-actions">
                <button
                  ref={cancelDiscardRef}
                  type="button"
                  disabled={pending === 'DISCARD_CURRENT_RECORDING'}
                  onClick={() => setConfirmDiscard(false)}
                >
                  {t().common.cancel}
                </button>
                <button
                  type="button"
                  data-danger="true"
                  disabled={pending === 'DISCARD_CURRENT_RECORDING'}
                  onClick={() => void handleDiscard()}
                >
                  {pending === 'DISCARD_CURRENT_RECORDING' ? t().common.processing : t().toolbar.discard}
                </button>
              </div>
            </div>
          )}

          {confirmSwitch && (
            <div
              className="ft-confirm"
              role="alertdialog"
              aria-modal="true"
              aria-labelledby={confirmTitleId}
              aria-describedby={confirmDescriptionId}
              onKeyDown={handleConfirmKeyDown}
            >
              <h2 className="ft-confirm-title" id={confirmTitleId}>{t().toolbar.switchToStepsTitle}</h2>
              <p className="ft-confirm-copy" id={confirmDescriptionId}>
                {t().toolbar.switchToStepsBody(state.itemCount)}
              </p>
              <div className="ft-confirm-actions ft-confirm-actions--stacked">
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void handleConfirmSwitch('SWITCH_TO_STEPS_MODE')}
                >
                  {pending === 'SWITCH_TO_STEPS_MODE' ? t().common.processing : t().toolbar.finishSnapshotAndSwitch}
                </button>
                <button
                  type="button"
                  data-danger="true"
                  disabled={busy}
                  onClick={() => void handleConfirmSwitch('SWITCH_TO_STEPS_MODE_DISCARD_SNAPSHOT')}
                >
                  {pending === 'SWITCH_TO_STEPS_MODE_DISCARD_SNAPSHOT' ? t().common.processing : t().toolbar.discardSnapshotAndSwitch}
                </button>
                <button
                  ref={cancelSwitchRef}
                  type="button"
                  disabled={busy}
                  onClick={() => setConfirmSwitch(false)}
                >
                  {t().toolbar.stayInSnapshot}
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
              aria-label={t().toolbar.expandLabel(statusLabel)}
              data-tooltip={t().toolbar.expandTooltip}
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
              aria-label={t().toolbar.controlsLabel}
            >
              {invalidated ? (
                <>
                  <div className="ft-invalidated-status" role="status">
                    <TriangleAlert aria-hidden="true" />
                    <span className="ft-invalidated-copy">{t().toolbar.viewportChanged}</span>
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
                      aria-label={t().toolbar.discardLabel}
                      data-tooltip={t().toolbar.discardLabel}
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
                      {pending === 'FINISH_RECORDING' ? t().toolbar.finishing : t().toolbar.finishRecording}
                    </button>
                    <button
                      type="button"
                      className="ft-finish"
                      disabled={busy}
                      onClick={() => void run('REBUILD_INVALIDATED_SNAPSHOT')}
                    >
                      {pending === 'REBUILD_INVALIDATED_SNAPSHOT' ? <Loader2 /> : <Plus />}
                      {pending === 'REBUILD_INVALIDATED_SNAPSHOT' ? t().toolbar.rebuilding : t().toolbar.keepAndRebuild}
                    </button>
                  </div>
                </>
              ) : (
                <>
                  <button
                    type="button"
                    className="ft-status"
                    data-frametrail-toolbar-position=""
                    aria-label={t().toolbar.moveLabel(preparingNext ? t().toolbar.nextPending : statusLabel)}
                    data-tooltip={t().toolbar.moveTooltip}
                    onPointerDown={handlePositionPointerDown}
                    onPointerMove={handlePositionPointerMove}
                    onPointerUp={finishPositionDrag}
                    onPointerCancel={finishPositionDrag}
                    onKeyDown={handlePositionKeyDown}
                  >
                    <span className="ft-dot" aria-hidden="true" />
                    <span className="ft-status-text">
                      {regionCaptureActive
                        ? t().toolbar.regionCapturing
                        : preparingNext ? t().toolbar.nextPending : t().toolbar.captured}
                    </span>
                    <span className="ft-count-badge">{state.itemCount}</span>
                  </button>

                  <span className="ft-divider" aria-hidden="true" />

                  <div className="ft-mode-switch" role="radiogroup" aria-label={t().common.recordingMode}>
                    {MODE_OPTIONS.map((option) => (
                      <button
                        key={option}
                        type="button"
                        role="radio"
                        aria-checked={state.mode === option}
                        disabled={busy || regionCaptureActive}
                        onClick={() => handleSwitchMode(option)}
                      >
                        {pending === modeSwitchAction(option) ? <Loader2 /> : recordingModeCopy(option).label}
                      </button>
                    ))}
                  </div>

                  <div className="ft-actions-group">
                    {!preparingNext && (
                      <button
                        type="button"
                        className="ft-button"
                        aria-label={t().toolbar.undo}
                        data-tooltip={t().toolbar.undoTooltip}
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
                        aria-label={regionCaptureActive ? t().toolbar.regionCaptureActive : t().toolbar.cropRegion}
                        data-tooltip={regionCaptureActive ? t().toolbar.regionCaptureActive : t().toolbar.cropRegion}
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
                        aria-label={paused ? t().toolbar.resume : t().toolbar.pause}
                        data-tooltip={paused ? t().toolbar.resume : t().toolbar.pause}
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
                        aria-label={t().toolbar.finishAndNextSnapshot}
                        data-tooltip={t().toolbar.finishAndNextSnapshot}
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
                      aria-label={t().toolbar.discardLabel}
                      data-tooltip={t().toolbar.discardLabel}
                      disabled={busy}
                      onClick={() => setConfirmDiscard(true)}
                    >
                      <Trash2 size={17} />
                    </button>
                    <button
                      type="button"
                      className="ft-button"
                      aria-label={t().toolbar.collapse}
                      data-tooltip={t().toolbar.collapse}
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
                      : preparingNext ? t().toolbar.createSnapshot : t().toolbar.finish}
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
