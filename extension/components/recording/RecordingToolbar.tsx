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
  /* The toolbar mounts in two places: a closed shadow root on recorded pages
   * (recording-toolbar-host.tsx) and directly in the snapshot-shield iframe
   * document (entrypoints/snapshot-shield/main.tsx). ":host" only matches in
   * the shadow-root case, so every theme variable is declared on ".ft-layer"
   * as well — otherwise the iframe copy renders with unset variables
   * (transparent surface, wrong text colors). */
  :host, .ft-layer {
    color-scheme: light;
    --ft-radius: 8px;
    --ft-surface: #ffffff;
    --ft-text: #1c1c1c;
    --ft-status-text: #1c1c1c;
    --ft-muted: rgba(28, 28, 28, .6);
    --ft-border: rgba(28, 28, 28, .12);
    --ft-primary: #7094f4;
    --ft-primary-text: #ffffff;
    --ft-recording: #ff4747;
    --ft-focus: #7094f4;
    --ft-divider: rgba(28, 28, 28, .12);
    --ft-actions-bg: rgba(28, 28, 28, .05);
    --ft-btn-text: rgba(28, 28, 28, .72);
    --ft-btn-hover-bg: rgba(28, 28, 28, .08);
    --ft-btn-danger-hover-bg: rgba(255, 71, 71, .14);
    --ft-btn-danger-hover-text: #e23b3b;
    --ft-error-text: #c62828;
    --ft-warning: #b45309;
    --ft-link: #4f6fce;
    --ft-shadow: 0 12px 34px -8px rgba(0,0,0,.35), inset 0 1px 0 rgba(255,255,255,.6);
  }
  @media (prefers-color-scheme: dark) {
    :host, .ft-layer {
      color-scheme: dark;
      --ft-surface: #1c1c1c;
      --ft-text: #ffffff;
      --ft-status-text: #ffffff;
      --ft-muted: rgba(255, 255, 255, .65);
      --ft-border: rgba(255, 255, 255, .14);
      --ft-primary: #7094f4;
      --ft-primary-text: #ffffff;
      --ft-recording: #ff4747;
      --ft-focus: #60a5fa;
      --ft-divider: rgba(255, 255, 255, .14);
      --ft-actions-bg: rgba(255, 255, 255, .06);
      --ft-btn-text: rgba(255, 255, 255, .85);
      --ft-btn-hover-bg: rgba(255, 255, 255, .12);
      --ft-btn-danger-hover-bg: rgba(255, 71, 71, .2);
      --ft-btn-danger-hover-text: #ff8080;
      --ft-error-text: #ff8a8a;
      --ft-warning: #fbbf24;
      --ft-link: #7094f4;
      --ft-shadow: 0 12px 34px -8px rgba(0,0,0,.5), inset 0 1px 0 rgba(255,255,255,.06);
    }
  }
  * { box-sizing: border-box; letter-spacing: 0; }
  button { font: inherit; }
  .ft-layer {
    position: fixed; inset: 0; z-index: 2147483647; pointer-events: none;
    font-family: 'Inter', -apple-system, BlinkMacSystemFont, "Noto Sans TC", "PingFang TC", sans-serif;
    font-size: 14px; line-height: 1.4;
  }
  .ft-position {
    position: absolute; left: 0; top: 0; z-index: 2; max-width: calc(100vw - 32px); pointer-events: auto;
  }
  .ft-modal-backdrop { position: absolute; inset: 0; z-index: 1; pointer-events: auto; background: transparent; }
  .ft-toolbar {
    height: 58px; max-width: min(520px, calc(100vw - 32px)); display: flex; align-items: center; gap: 12px;
    padding: 0 8px 0 18px; border: 1px solid var(--ft-border); border-radius: 999px;
    background: var(--ft-surface); color: var(--ft-text); box-shadow: var(--ft-shadow);
  }
  .ft-toolbar--invalidated {
    width: min(520px, calc(100vw - 32px)); height: auto; max-width: calc(100vw - 32px); gap: 10px;
    padding: 8px; border-radius: var(--ft-radius);
  }
  .ft-invalidated-status { min-width: 0; flex: 1 1 240px; display: flex; align-items: center; gap: 8px; }
  .ft-invalidated-status svg { width: 18px; height: 18px; flex: none; color: var(--ft-warning); }
  .ft-invalidated-copy { min-width: 0; font-size: 12px; font-weight: 600; white-space: normal; }
  .ft-invalidated-actions { flex: none; display: flex; align-items: center; gap: 2px; }
  .ft-status {
    min-width: 0; height: 42px; display: flex; align-items: center; gap: 9px;
    padding: 0; border: 0; background: transparent; color: inherit; white-space: nowrap; cursor: grab;
    touch-action: none;
  }
  .ft-status:active, .ft-collapsed:active { cursor: grabbing; }
  .ft-dot { width: 9px; height: 9px; flex: none; border-radius: 99px; background: var(--ft-recording); box-shadow: 0 0 0 4px rgba(255,71,71,.22); }
  .ft-status-text { min-width: 0; overflow: hidden; text-overflow: ellipsis; font-size: 13px; font-weight: 600; color: var(--ft-status-text); }
  .ft-count-badge { min-width: 24px; height: 24px; padding: 0 8px; border-radius: 99px; background: var(--ft-primary); color: var(--ft-primary-text); font-size: 13px; font-weight: 700; display: flex; align-items: center; justify-content: center; font-variant-numeric: tabular-nums; }
  .ft-divider { width: 1px; height: 26px; background: var(--ft-divider); flex: none; }
  .ft-actions-group { display: flex; align-items: center; gap: 2px; padding: 4px; border-radius: var(--ft-radius); background: var(--ft-actions-bg); }
  .ft-button {
    width: 36px; height: 36px; flex: none; display: inline-flex; align-items: center; justify-content: center;
    padding: 0; border: 0; border-radius: 99px; background: transparent; color: var(--ft-btn-text); cursor: pointer; transition: background .15s, color .15s;
  }
  .ft-button:hover:not(:disabled) { background: var(--ft-btn-hover-bg); color: var(--ft-text); }
  .ft-button[data-danger="true"]:hover:not(:disabled) { background: var(--ft-btn-danger-hover-bg); color: var(--ft-btn-danger-hover-text); }
  .ft-button:disabled { opacity: .42; cursor: default; }
  .ft-button:focus-visible, .ft-status:focus-visible, .ft-collapsed:focus-visible, .ft-finish:focus-visible,
  .ft-secondary:focus-visible, .ft-menu button:focus-visible, .ft-confirm button:focus-visible,
  .ft-snackbar button:focus-visible {
    outline: 2px solid var(--ft-focus); outline-offset: 2px;
  }
  .ft-button svg { width: 17px; height: 17px; }
  .ft-finish {
    height: 42px; flex: none; display: inline-flex; align-items: center; justify-content: center; gap: 6px;
    padding: 0 22px; border: 0; border-radius: 999px; background: var(--ft-primary);
    color: var(--ft-primary-text); font-size: 15px; font-weight: 700; cursor: pointer; white-space: nowrap; transition: background .15s;
  }
  .ft-finish:hover:not(:disabled) { background: #5f83e8; }
  .ft-finish:disabled { opacity: .68; cursor: wait; }
  .ft-secondary {
    height: 36px; flex: none; display: inline-flex; align-items: center; justify-content: center;
    padding: 0 11px; border: 0; border-radius: 999px; background: transparent; color: var(--ft-muted);
    font-weight: 600; cursor: pointer; white-space: nowrap;
  }
  .ft-secondary:hover:not(:disabled) { background: var(--ft-btn-hover-bg); color: var(--ft-text); }
  .ft-secondary:disabled { opacity: .5; cursor: wait; }
  .ft-collapsed {
    position: relative; height: 48px; padding: 0 8px 0 16px; display: flex; align-items: center; gap: 11px;
    border: 1px solid var(--ft-border); border-radius: 999px; background: var(--ft-surface); color: var(--ft-text);
    box-shadow: var(--ft-shadow); cursor: pointer; touch-action: none;
  }
  .ft-collapsed-expand { display: flex; align-items: center; justify-content: center; width: 32px; height: 32px; border-radius: 999px; background: var(--ft-btn-hover-bg); color: var(--ft-text); }
  .ft-message, .ft-snackbar, .ft-menu, .ft-confirm {
    position: absolute; right: 0; bottom: calc(100% + 8px); min-width: 220px; max-width: min(320px, calc(100vw - 32px));
    padding: 10px 12px; border: 1px solid var(--ft-border); border-radius: var(--ft-radius); background: var(--ft-surface);
    color: var(--ft-text); box-shadow: 0 8px 24px rgba(28, 25, 23, .18); font-size: 12px;
  }
  .ft-message { display: flex; align-items: center; gap: 8px; }
  .ft-message[data-kind="error"] { color: var(--ft-error-text); }
  .ft-snackbar { display: flex; align-items: center; justify-content: space-between; gap: 16px; }
  .ft-snackbar button { border: 0; background: transparent; color: var(--ft-link); font-weight: 700; cursor: pointer; }
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
    border: 0; border-radius: var(--ft-radius); background: transparent; color: var(--ft-text); text-align: left; cursor: pointer;
  }
  .ft-menu button:hover:not(:disabled) { background: var(--ft-btn-hover-bg); }
  .ft-menu button[data-danger="true"] { color: var(--ft-error-text); }
  .ft-menu svg { width: 17px; height: 17px; flex: none; }
  .ft-confirm { width: min(300px, calc(100vw - 32px)); padding: 16px; }
  .ft-confirm-title { margin: 0; font-size: 14px; font-weight: 700; }
  .ft-confirm-copy { margin: 6px 0 16px; color: var(--ft-muted); font-size: 12px; line-height: 1.5; }
  .ft-confirm-actions { display: flex; justify-content: flex-end; gap: 8px; }
  .ft-confirm button {
    min-height: 36px; padding: 0 12px; border: 1px solid var(--ft-border); border-radius: var(--ft-radius);
    background: transparent; color: var(--ft-text); font-weight: 600; cursor: pointer;
  }
  .ft-confirm button[data-danger="true"] { border-color: var(--ft-recording); background: var(--ft-recording); color: #fff; }
  .ft-confirm button:disabled, .ft-menu button:disabled { opacity: .5; cursor: wait; }
  .ft-success { width: 18px; height: 18px; color: var(--ft-link); }
  .ft-sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0,0,0,0); white-space: nowrap; border: 0; }
  @media (max-width: 520px) {
    .ft-position { max-width: calc(100vw - 16px); }
    .ft-toolbar:not(.ft-toolbar--invalidated) {
      width: calc(100vw - 16px); height: auto; min-height: 0; max-width: calc(100vw - 16px);
      flex-wrap: wrap; gap: 6px; padding: 7px 8px; border-radius: var(--ft-radius);
    }
    .ft-toolbar:not(.ft-toolbar--invalidated) .ft-status { flex: 1 1 100%; height: 32px; padding: 0 4px; }
    .ft-toolbar:not(.ft-toolbar--invalidated) .ft-divider { display: none; }
    .ft-toolbar:not(.ft-toolbar--invalidated) .ft-actions-group { flex: 1 1 0; justify-content: space-around; gap: 0; padding: 3px; }
    .ft-toolbar:not(.ft-toolbar--invalidated) .ft-button { width: 32px; height: 32px; }
    .ft-toolbar:not(.ft-toolbar--invalidated) .ft-finish { height: 38px; padding: 0 14px; font-size: 14px; }
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
      if (!active || !isRecordingToolbarCorner(saved)) return;
      // Mount-time restore applies the saved corner without persisting it
      // back; inlined instead of moveToCorner(saved, false) so this one-shot
      // effect depends on nothing reactive.
      setCorner(saved);
      setPosition(positionForToolbarCorner(saved, floatingSize(), viewport(), margin()));
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
              aria-label={`${paused ? '已暫停' : '錄製中'}，${modeLabel}，${state.itemCount} 筆；展開錄製控制`}
              title="展開控制器"
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
                        : preparingNext ? '下一張尚未建立' : '已擷取'}
                    </span>
                    <span className="ft-count-badge">{state.itemCount}</span>
                  </button>

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
