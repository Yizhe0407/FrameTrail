import { useEffect, useRef, useState } from 'react';
import {
  Check,
  ChevronDown,
  Loader2,
  Pause,
  Play,
  Plus,
  Undo2,
} from 'lucide-react';
import type {
  RecordingControlMessage,
  RecordingControlResult,
  RecordingMode,
  RecordingPhase,
} from '@/lib/messages';

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
  .ft-position { position: absolute; right: 16px; bottom: 16px; max-width: calc(100vw - 32px); pointer-events: auto; }
  .ft-toolbar {
    height: 44px; max-width: min(360px, calc(100vw - 32px)); display: flex; align-items: center; gap: 2px;
    padding: 0 4px 0 12px; border: 1px solid var(--ft-border); border-radius: 999px;
    background: var(--ft-surface); color: var(--ft-text); box-shadow: 0 8px 24px rgb(28 25 23 / .2);
  }
  .ft-status { min-width: 0; display: flex; align-items: center; gap: 8px; margin-right: 4px; white-space: nowrap; }
  .ft-dot { width: 8px; height: 8px; flex: none; border-radius: 50%; background: var(--ft-recording); }
  .ft-status-text { overflow: hidden; text-overflow: ellipsis; font-size: 12px; font-weight: 600; font-variant-numeric: tabular-nums; }
  .ft-button {
    width: 40px; height: 40px; flex: none; display: inline-flex; align-items: center; justify-content: center;
    padding: 0; border: 0; border-radius: 50%; background: transparent; color: var(--ft-muted); cursor: pointer;
  }
  .ft-button:hover:not(:disabled) { background: #f5f5f4; color: var(--ft-text); }
  .ft-button:disabled { opacity: .42; cursor: default; }
  .ft-button:focus-visible, .ft-finish:focus-visible, .ft-secondary:focus-visible, .ft-snackbar button:focus-visible {
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
    box-shadow: 0 8px 24px rgb(28 25 23 / .2); cursor: pointer;
  }
  .ft-collapsed .ft-dot { position: absolute; left: 9px; top: 9px; }
  .ft-count { font-size: 12px; font-weight: 700; font-variant-numeric: tabular-nums; }
  .ft-message, .ft-snackbar {
    position: absolute; right: 0; bottom: 52px; min-width: 220px; max-width: min(320px, calc(100vw - 32px));
    padding: 10px 12px; border: 1px solid var(--ft-border); border-radius: 8px; background: var(--ft-surface);
    color: var(--ft-text); box-shadow: 0 8px 24px rgb(28 25 23 / .18); font-size: 12px;
  }
  .ft-message { display: flex; align-items: center; gap: 8px; }
  .ft-message[data-kind="error"] { color: #9f1239; }
  .ft-snackbar { display: flex; align-items: center; justify-content: space-between; gap: 16px; }
  .ft-snackbar button { border: 0; background: transparent; color: var(--ft-primary); font-weight: 700; cursor: pointer; }
  .ft-success { width: 18px; height: 18px; color: var(--ft-primary); }
  .ft-sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0,0,0,0); white-space: nowrap; border: 0; }
  @media (prefers-color-scheme: dark) {
    .ft-layer { --ft-surface: #292524; --ft-text: #fafaf9; --ft-muted: #d6d3d1; --ft-border: #57534e; --ft-primary: #a3e635; --ft-primary-text: #1c1917; --ft-recording: #fb7185; --ft-focus: #60a5fa; }
    .ft-button:hover:not(:disabled) { background: #44403c; }
    .ft-secondary:hover:not(:disabled) { background: #44403c; }
    .ft-message[data-kind="error"] { color: #fda4af; }
  }
  @media (prefers-reduced-motion: reduce) { .ft-layer * { animation: none !important; transition: none !important; } }
`;

export default function RecordingToolbar({ state, onCommand, onUndoApplied, onRestoreApplied }: Props) {
  const [collapsed, setCollapsed] = useState(false);
  const [pending, setPending] = useState<ToolbarAction | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const [undo, setUndo] = useState<{ token: string; itemNumber: number } | null>(null);
  const [showSuccess, setShowSuccess] = useState(false);
  const previousCount = useRef(state.itemCount);

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
    if (!undo) return;
    const timer = window.setTimeout(() => setUndo(null), 5_000);
    return () => window.clearTimeout(timer);
  }, [undo]);

  async function run(action: ToolbarAction, token?: string): Promise<RecordingControlResult> {
    if (pending) return { ok: false, error: '另一個動作仍在處理中。' };
    setPending(action);
    setMessage(null);
    try {
      const result = await onCommand(action, token);
      if (!result.ok) setMessage(result.error);
      return result;
    } catch (error) {
      console.error('[frametrail] recording toolbar command failed', error);
      const result = { ok: false, error: '動作失敗，請再試一次。' } as const;
      setMessage(result.error);
      return result;
    } finally {
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

  const modeLabel = state.mode === 'steps' ? '操作流程' : '單頁標註';
  const paused = state.phase === 'paused';
  const preparingNext = state.mode === 'snapshot' && state.phase === 'preparing-next';
  const busy = pending !== null || state.phase === 'finishing';

  if (state.phase === 'starting') return null;

  return (
    <>
      <style>{styles}</style>
      <div className="ft-layer">
        <div className="ft-position">
          {(message || state.error) && (
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

          {collapsed ? (
            <button
              type="button"
              className="ft-collapsed"
              aria-label={`${modeLabel}錄製中，${state.itemCount} 筆；展開錄製控制`}
              title="展開錄製控制"
              onClick={() => setCollapsed(false)}
            >
              <span className="ft-dot" aria-hidden="true" />
              <span className="ft-count">{state.itemCount}</span>
            </button>
          ) : (
            <div className="ft-toolbar" role="toolbar" aria-label="錄製控制">
              <div
                className="ft-status"
                aria-label={preparingNext ? '下一張尚未建立' : `${paused ? '已暫停' : '錄製中'}，${modeLabel}，${state.itemCount} 筆`}
              >
                <span className="ft-dot" aria-hidden="true" />
                <span className="ft-status-text">
                  {preparingNext ? '下一張尚未建立' : `${paused ? '已暫停' : modeLabel} · ${state.itemCount}`}
                </span>
              </div>
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
              {!preparingNext && (
                <button
                  type="button"
                  className="ft-button"
                  aria-label="收合錄製控制"
                  title="收合"
                  disabled={busy}
                  onClick={() => setCollapsed(true)}
                >
                  <ChevronDown />
                </button>
              )}
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
            </div>
          )}
        </div>
        <div className="ft-sr-only" aria-live="polite" aria-atomic="true">{announcement}</div>
      </div>
    </>
  );
}
