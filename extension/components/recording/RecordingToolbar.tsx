import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { browser } from 'wxt/browser';
import {
  Check,
  Crop,
  Loader2,
  Minimize2,
  MoreHorizontal,
  Pause,
  Play,
  Plus,
  Trash2,
  TriangleAlert,
  Undo2,
} from 'lucide-react';
import type {
  RecordingControlMessage,
  RecordingControlResult,
  RecordingMode,
  RecordingPhase,
} from '@/lib/runtime/messages';
import {
  clampToolbarPosition,
  isRecordingToolbarCorner,
  moveToolbarCorner,
  positionForToolbarCorner,
  RECORDING_TOOLBAR_CORNER_KEY,
  snapToolbarCorner,
  toolbarCornerLabel,
  type RecordingToolbarCorner,
  type ToolbarPoint,
} from '@/lib/recording/recording-toolbar-position';
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
}

const styles = `
  :host { color-scheme: light dark; }
  * { box-sizing: border-box; letter-spacing: 0; }
  button { font: inherit; }
  .ft-layer {
    --ft-surface: #fff; --ft-text: #1c1917; --ft-muted: #57534e;
    --ft-border: #d6d3d1; --ft-primary: #4d7c0f; --ft-primary-text: #fff;
    --ft-recording: #be123c; --ft-focus: #2563eb;
    position: fixed; inset: 0; z-index: 2147483647; pointer-events: none;
    font-family: -apple-system, BlinkMacSystemFont, "Noto Sans TC", "PingFang TC", "Microsoft JhengHei", sans-serif;
    font-size: 14px; line-height: 1.4;
  }
  .ft-position {
    position: absolute; left: 0; top: 0; z-index: 2; max-width: calc(100vw - 32px); pointer-events: auto;
  }
  .ft-modal-backdrop { position: absolute; inset: 0; z-index: 1; pointer-events: auto; background: transparent; }
  .ft-toolbar {
    height: 44px; max-width: min(360px, calc(100vw - 32px)); display: flex; align-items: center; gap: 2px;
    padding: 0 4px 0 12px; border: 1px solid var(--ft-border); border-radius: 999px;
    background: var(--ft-surface); color: var(--ft-text); box-shadow: 0 8px 24px rgb(28 25 23 / .2);
  }
  .ft-toolbar--invalidated {
    width: min(520px, calc(100vw - 32px)); height: auto; max-width: calc(100vw - 32px); gap: 10px;
    padding: 8px; border-radius: 8px;
  }
  .ft-invalidated-status { min-width: 0; flex: 1 1 240px; display: flex; align-items: center; gap: 8px; }
  .ft-invalidated-status svg { width: 18px; height: 18px; flex: none; color: #b45309; }
  .ft-invalidated-copy { min-width: 0; font-size: 12px; font-weight: 600; white-space: normal; }
  .ft-invalidated-actions { flex: none; display: flex; align-items: center; gap: 2px; }
  .ft-status {
    min-width: 0; height: 40px; display: flex; align-items: center; gap: 8px; margin-right: 4px;
    padding: 0; border: 0; background: transparent; color: inherit; white-space: nowrap; cursor: grab;
    touch-action: none;
  }
  .ft-status:active, .ft-collapsed:active { cursor: grabbing; }
  .ft-dot { width: 8px; height: 8px; flex: none; border-radius: 50%; background: var(--ft-recording); }
  .ft-status-text { overflow: hidden; text-overflow: ellipsis; font-size: 12px; font-weight: 600; font-variant-numeric: tabular-nums; }
  .ft-button {
    width: 40px; height: 40px; flex: none; display: inline-flex; align-items: center; justify-content: center;
    padding: 0; border: 0; border-radius: 50%; background: transparent; color: var(--ft-muted); cursor: pointer;
  }
  .ft-button:hover:not(:disabled) { background: #f5f5f4; color: var(--ft-text); }
  .ft-button:disabled { opacity: .42; cursor: default; }
  .ft-button:focus-visible, .ft-status:focus-visible, .ft-collapsed:focus-visible, .ft-finish:focus-visible,
  .ft-secondary:focus-visible, .ft-menu button:focus-visible, .ft-confirm button:focus-visible,
  .ft-snackbar button:focus-visible {
    outline: 2px solid var(--ft-focus); outline-offset: 2px;
  }
  .ft-button svg, .ft-finish svg { width: 17px; height: 17px; }
  .ft-finish {
    height: 36px; flex: none; display: inline-flex; align-items: center; justify-content: center; gap: 6px;
    margin-left: 2px; padding: 0 13px; border: 0; border-radius: 999px; background: var(--ft-primary);
    color: var(--ft-primary-text); font-weight: 600; cursor: pointer; white-space: nowrap;
  }
  .ft-finish:disabled { opacity: .68; cursor: wait; }
  .ft-secondary {
    height: 36px; flex: none; display: inline-flex; align-items: center; justify-content: center;
    padding: 0 11px; border: 0; border-radius: 999px; background: transparent; color: var(--ft-muted);
    font-weight: 600; cursor: pointer; white-space: nowrap;
  }
  .ft-secondary:hover:not(:disabled) { background: #f5f5f4; color: var(--ft-text); }
  .ft-secondary:disabled { opacity: .5; cursor: wait; }
  .ft-collapsed {
    position: relative; width: 44px; height: 44px; display: flex; align-items: center; justify-content: center;
    border: 1px solid var(--ft-border); border-radius: 50%; background: var(--ft-surface); color: var(--ft-text);
    box-shadow: 0 8px 24px rgb(28 25 23 / .2); cursor: grab; touch-action: none;
  }
  .ft-collapsed .ft-dot { position: absolute; left: 9px; top: 9px; }
  .ft-count { font-size: 12px; font-weight: 700; font-variant-numeric: tabular-nums; }
  .ft-message, .ft-snackbar, .ft-menu, .ft-confirm {
    position: absolute; right: 0; bottom: calc(100% + 8px); min-width: 220px; max-width: min(320px, calc(100vw - 32px));
    padding: 10px 12px; border: 1px solid var(--ft-border); border-radius: 8px; background: var(--ft-surface);
    color: var(--ft-text); box-shadow: 0 8px 24px rgb(28 25 23 / .18); font-size: 12px;
  }
  .ft-message { display: flex; align-items: center; gap: 8px; }
  .ft-message[data-kind="error"] { color: #9f1239; }
  .ft-snackbar { display: flex; align-items: center; justify-content: space-between; gap: 16px; }
  .ft-snackbar button { border: 0; background: transparent; color: var(--ft-primary); font-weight: 700; cursor: pointer; }
  .ft-position[data-vertical="top"] .ft-message,
  .ft-position[data-vertical="top"] .ft-snackbar,
  .ft-position[data-vertical="top"] .ft-menu,
  .ft-position[data-vertical="top"] .ft-confirm { top: calc(100% + 8px); bottom: auto; }
  .ft-position[data-horizontal="left"] .ft-message,
  .ft-position[data-horizontal="left"] .ft-snackbar,
  .ft-position[data-horizontal="left"] .ft-menu,
  .ft-position[data-horizontal="left"] .ft-confirm { left: 0; right: auto; }
  .ft-menu { min-width: 190px; padding: 4px; }
  .ft-menu button {
    width: 100%; min-height: 40px; display: flex; align-items: center; gap: 10px; padding: 8px 10px;
    border: 0; border-radius: 6px; background: transparent; color: var(--ft-text); text-align: left; cursor: pointer;
  }
  .ft-menu button:hover:not(:disabled) { background: #f5f5f4; }
  .ft-menu button[data-danger="true"] { color: #9f1239; }
  .ft-menu svg { width: 17px; height: 17px; flex: none; }
  .ft-confirm { width: min(300px, calc(100vw - 32px)); padding: 16px; }
  .ft-confirm-title { margin: 0; font-size: 14px; font-weight: 700; }
  .ft-confirm-copy { margin: 6px 0 16px; color: var(--ft-muted); font-size: 12px; line-height: 1.5; }
  .ft-confirm-actions { display: flex; justify-content: flex-end; gap: 8px; }
  .ft-confirm button {
    min-height: 36px; padding: 0 12px; border: 1px solid var(--ft-border); border-radius: 6px;
    background: transparent; color: var(--ft-text); font-weight: 600; cursor: pointer;
  }
  .ft-confirm button[data-danger="true"] { border-color: #be123c; background: #be123c; color: #fff; }
  .ft-confirm button:disabled, .ft-menu button:disabled { opacity: .5; cursor: wait; }
  .ft-success { width: 18px; height: 18px; color: var(--ft-primary); }
  .ft-sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0,0,0,0); white-space: nowrap; border: 0; }
  @media (prefers-color-scheme: dark) {
    .ft-layer { --ft-surface: #292524; --ft-text: #fafaf9; --ft-muted: #d6d3d1; --ft-border: #57534e; --ft-primary: #a3e635; --ft-primary-text: #1c1917; --ft-recording: #fb7185; --ft-focus: #60a5fa; }
    .ft-button:hover:not(:disabled) { background: #44403c; }
    .ft-secondary:hover:not(:disabled) { background: #44403c; }
    .ft-menu button:hover:not(:disabled) { background: #44403c; }
    .ft-message[data-kind="error"] { color: #fda4af; }
    .ft-menu button[data-danger="true"] { color: #fda4af; }
    .ft-invalidated-status svg { color: #fbbf24; }
  }
  @media (max-width: 520px) {
    .ft-position { max-width: calc(100vw - 16px); }
    .ft-toolbar--invalidated { width: calc(100vw - 16px); max-width: calc(100vw - 16px); flex-wrap: wrap; }
    .ft-invalidated-status { flex-basis: 100%; padding: 2px 4px; }
    .ft-invalidated-actions { width: 100%; }
    .ft-invalidated-actions .ft-secondary, .ft-invalidated-actions .ft-finish { flex: 1; }
  }
  @media (prefers-reduced-motion: reduce) { .ft-layer * { animation: none !important; transition: none !important; } }
`;

export default function RecordingToolbar({
  state,
  onCommand,
  onUndoApplied,
  onRestoreApplied,
  onStartRegionCapture,
  regionCaptureActive = false,
}: Props) {
  const [collapsed, setCollapsed] = useState(false);
  const [pending, setPending] = useState<ToolbarAction | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const [undo, setUndo] = useState<{ token: string; itemNumber: number } | null>(null);
  const [showSuccess, setShowSuccess] = useState(false);
  const [corner, setCorner] = useState<RecordingToolbarCorner>('bottom-right');
  const [position, setPosition] = useState<ToolbarPoint | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const previousCount = useRef(state.itemCount);
  const pendingRef = useRef<ToolbarAction | null>(null);
  const floatingRef = useRef<HTMLElement | null>(null);
  const cancelDiscardRef = useRef<HTMLButtonElement | null>(null);
  const suppressCollapsedClick = useRef(false);
  const dragRef = useRef<{
    pointerId: number;
    startClientX: number;
    startClientY: number;
    startPosition: ToolbarPoint;
    position: ToolbarPoint;
    moved: boolean;
  } | null>(null);
  const menuId = useId();
  const confirmTitleId = useId();
  const confirmDescriptionId = useId();

  const viewport = () => ({ width: window.innerWidth, height: window.innerHeight });
  const margin = () => window.innerWidth <= 520 ? 8 : 16;
  const floatingSize = () => {
    const rect = floatingRef.current?.getBoundingClientRect();
    return {
      width: rect && rect.width > 0 ? rect.width : 44,
      height: rect && rect.height > 0 ? rect.height : 44,
    };
  };

  const persistCorner = (nextCorner: RecordingToolbarCorner) => {
    void browser.storage.local.set({ [RECORDING_TOOLBAR_CORNER_KEY]: nextCorner }).catch((error) => {
      console.warn('[frametrail] failed to save recording toolbar position', error);
    });
  };

  const moveToCorner = (nextCorner: RecordingToolbarCorner, persist = true) => {
    setCorner(nextCorner);
    setPosition(positionForToolbarCorner(nextCorner, floatingSize(), viewport(), margin()));
    if (persist) persistCorner(nextCorner);
  };

  useEffect(() => {
    let active = true;
    void browser.storage.local.get(RECORDING_TOOLBAR_CORNER_KEY).then((stored) => {
      const saved = stored[RECORDING_TOOLBAR_CORNER_KEY];
      if (active && isRecordingToolbarCorner(saved)) moveToCorner(saved, false);
    }).catch((error) => {
      console.warn('[frametrail] failed to load recording toolbar position', error);
    });
    return () => { active = false; };
  }, []);

  useLayoutEffect(() => {
    const reposition = () => {
      if (dragRef.current) return;
      const next = positionForToolbarCorner(corner, floatingSize(), viewport(), margin());
      setPosition((current) => current?.x === next.x && current.y === next.y ? current : next);
    };
    reposition();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(reposition);
    if (floatingRef.current) observer?.observe(floatingRef.current);
    window.addEventListener('resize', reposition);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', reposition);
    };
  }, [corner, collapsed, state.phase]);

  useEffect(() => {
    if (confirmDiscard) cancelDiscardRef.current?.focus();
  }, [confirmDiscard]);

  useEffect(() => {
    if (state.itemCount > previousCount.current) {
      const noun = state.mode === 'steps' ? '步驟' : '標註';
      setAnnouncement(`已${state.mode === 'steps' ? '建立' : '加入'}${noun} ${state.itemCount}`);
      setShowSuccess(true);
      const timer = window.setTimeout(() => setShowSuccess(false), 800);
      previousCount.current = state.itemCount;
      return () => window.clearTimeout(timer);
    }
    previousCount.current = state.itemCount;
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
        '錄製服務已中斷，請重新整理頁面後再試一次。',
      );
      if (!result.ok) setMessage(result.error);
      return result;
    } catch (error) {
      console.error('[frametrail] recording toolbar command failed', error);
      const result = { ok: false, error: '動作失敗，請再試一次。' } as const;
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
    setAnnouncement(`已移除${state.mode === 'steps' ? '步驟' : '標註'} ${result.removedItemNumber}`);
  }

  async function handleRestore() {
    if (!undo) return;
    const result = await run('RESTORE_LAST_CAPTURE', undo.token);
    if (!result.ok) return;
    onRestoreApplied?.();
    setUndo(null);
    setAnnouncement('已還原');
  }

  const handlePositionPointerDown = (event: ReactPointerEvent<HTMLElement>) => {
    if (!event.isPrimary || event.button !== 0 || pendingRef.current) return;
    const rect = floatingRef.current?.getBoundingClientRect();
    if (!rect) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    const startPosition = { x: rect.left, y: rect.top };
    dragRef.current = {
      pointerId: event.pointerId,
      startClientX: event.clientX,
      startClientY: event.clientY,
      startPosition,
      position: startPosition,
      moved: false,
    };
  };

  const handlePositionPointerMove = (event: ReactPointerEvent<HTMLElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const deltaX = event.clientX - drag.startClientX;
    const deltaY = event.clientY - drag.startClientY;
    if (!drag.moved && Math.hypot(deltaX, deltaY) < 4) return;
    drag.moved = true;
    drag.position = clampToolbarPosition(
      { x: drag.startPosition.x + deltaX, y: drag.startPosition.y + deltaY },
      floatingSize(),
      viewport(),
      margin(),
    );
    setPosition(drag.position);
  };

  const finishPositionDrag = (event: ReactPointerEvent<HTMLElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    dragRef.current = null;
    if (!drag.moved) return;
    suppressCollapsedClick.current = true;
    const nextCorner = snapToolbarCorner(drag.position, floatingSize(), viewport());
    moveToCorner(nextCorner);
    setAnnouncement(`錄製控制已移到${toolbarCornerLabel(nextCorner)}`);
  };

  const handlePositionKeyDown = (event: ReactKeyboardEvent<HTMLElement>) => {
    const directions = {
      ArrowUp: 'up',
      ArrowDown: 'down',
      ArrowLeft: 'left',
      ArrowRight: 'right',
    } as const;
    const direction = directions[event.key as keyof typeof directions];
    if (!direction) return;
    event.preventDefault();
    const nextCorner = moveToolbarCorner(corner, direction);
    moveToCorner(nextCorner);
    setAnnouncement(`錄製控制已移到${toolbarCornerLabel(nextCorner)}`);
  };

  const handleDiscard = async () => {
    const result = await run('DISCARD_CURRENT_RECORDING');
    if (result.ok) {
      setConfirmDiscard(false);
      setMenuOpen(false);
    }
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

  const modeLabel = state.mode === 'steps' ? '操作流程' : '單頁標註';
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
      <style>{styles}</style>
      <div
        className="ft-layer"
        onKeyDown={(event) => {
          if (event.key !== 'Escape' || pendingRef.current) return;
          setMenuOpen(false);
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
              <span>已移除{state.mode === 'steps' ? '步驟' : '標註'} {undo.itemNumber}</span>
              <button type="button" onClick={handleRestore} disabled={busy}>還原</button>
            </div>
          )}
          {menuOpen && !confirmDiscard && (
            <div className="ft-menu" id={menuId} role="menu" aria-label="更多錄製動作">
              {!invalidated && (
                <button
                  type="button"
                  role="menuitem"
                  disabled={busy}
                  onClick={() => {
                    setCollapsed(true);
                    setMenuOpen(false);
                  }}
                >
                  <Minimize2 aria-hidden="true" />
                  收合控制器
                </button>
              )}
              <button
                type="button"
                role="menuitem"
                data-danger="true"
                disabled={busy}
                onClick={() => {
                  setMenuOpen(false);
                  setConfirmDiscard(true);
                }}
              >
                <Trash2 aria-hidden="true" />
                放棄這次錄製
              </button>
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
              aria-label={`${modeLabel}錄製中，${state.itemCount} 筆；按一下展開，拖曳或使用方向鍵移動`}
              title="展開或移動錄製控制"
              onPointerDown={handlePositionPointerDown}
              onPointerMove={handlePositionPointerMove}
              onPointerUp={finishPositionDrag}
              onPointerCancel={finishPositionDrag}
              onKeyDown={handlePositionKeyDown}
              onClick={() => {
                if (suppressCollapsedClick.current) {
                  suppressCollapsedClick.current = false;
                  return;
                }
                setCollapsed(false);
              }}
            >
              <span className="ft-dot" aria-hidden="true" />
              <span className="ft-count">{state.itemCount}</span>
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
                    <button
                      type="button"
                      className="ft-button"
                      aria-label="更多錄製動作"
                      title="更多"
                      aria-haspopup="menu"
                      aria-expanded={menuOpen}
                      aria-controls={menuOpen ? menuId : undefined}
                      disabled={busy}
                      onClick={() => setMenuOpen((open) => !open)}
                    >
                      <MoreHorizontal />
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
                    aria-label={`${preparingNext ? '下一張尚未建立' : `${paused ? '已暫停' : '錄製中'}，${modeLabel}，${state.itemCount} 筆`}；拖曳或使用方向鍵移動`}
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
                        : preparingNext ? '下一張尚未建立' : `${paused ? '已暫停' : modeLabel} · ${state.itemCount}`}
                    </span>
                  </button>
                  {!preparingNext && onStartRegionCapture && (
                    <button
                      type="button"
                      className="ft-button"
                      aria-label={regionCaptureActive ? '區域擷取進行中' : '擷取畫面區域'}
                      title={regionCaptureActive ? '區域擷取進行中' : '拖曳擷取畫面區域'}
                      aria-pressed={regionCaptureActive}
                      disabled={busy || paused || regionCaptureActive || state.phase !== 'recording'}
                      onClick={() => onStartRegionCapture()}
                    >
                      <Crop />
                    </button>
                  )}
                  {!preparingNext && (
                    <button
                      type="button"
                      className="ft-button"
                      aria-label="復原上一個"
                      title="復原上一個"
                      disabled={busy || state.itemCount === 0}
                      onClick={handleUndo}
                    >
                      {pending === 'UNDO_LAST_CAPTURE' ? <Loader2 /> : <Undo2 />}
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
                        : paused ? <Play /> : <Pause />}
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
                      {pending === 'PREPARE_NEXT_SNAPSHOT' ? <Loader2 /> : <Plus />}
                    </button>
                  )}
                  <button
                    type="button"
                    className="ft-button"
                    aria-label="更多錄製動作"
                    title="更多"
                    aria-haspopup="menu"
                    aria-expanded={menuOpen}
                    aria-controls={menuOpen ? menuId : undefined}
                    disabled={busy}
                    onClick={() => setMenuOpen((open) => !open)}
                  >
                    <MoreHorizontal />
                  </button>
                  {preparingNext && (
                    <button
                      type="button"
                      className="ft-secondary"
                      disabled={busy}
                      onClick={() => void run('FINISH_RECORDING')}
                    >
                      {pending === 'FINISH_RECORDING' ? '整理中' : '完成錄製'}
                    </button>
                  )}
                  <button
                    type="button"
                    className="ft-finish"
                    disabled={busy}
                    onClick={() => void run(preparingNext ? 'CREATE_NEXT_SNAPSHOT' : 'FINISH_RECORDING')}
                  >
                    {pending === 'FINISH_RECORDING' || pending === 'CREATE_NEXT_SNAPSHOT' || state.phase === 'finishing'
                      ? <Loader2 />
                      : preparingNext ? <Plus /> : <Check />}
                    {preparingNext
                      ? pending === 'CREATE_NEXT_SNAPSHOT' ? '建立中' : '建立新快照'
                      : state.phase === 'finishing' ? '整理中' : state.mode === 'steps' ? '完成' : '完成快照'}
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
