import { BRAND_ACCENT, BRAND_DANGER } from '../capture/brand-colors';

/**
 * The recording toolbar's stylesheet, injected as a <style> tag inside its
 * mount target rather than relying on any page CSS.
 */
export const recordingToolbarStyles = `
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
    --ft-primary: ${BRAND_ACCENT};
    --ft-primary-text: #ffffff;
    --ft-recording: ${BRAND_DANGER};
    --ft-focus: ${BRAND_ACCENT};
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
      --ft-primary: ${BRAND_ACCENT};
      --ft-primary-text: #ffffff;
      --ft-recording: ${BRAND_DANGER};
      --ft-focus: #60a5fa;
      --ft-divider: rgba(255, 255, 255, .14);
      --ft-actions-bg: rgba(255, 255, 255, .06);
      --ft-btn-text: rgba(255, 255, 255, .85);
      --ft-btn-hover-bg: rgba(255, 255, 255, .12);
      --ft-btn-danger-hover-bg: rgba(255, 71, 71, .2);
      --ft-btn-danger-hover-text: #ff8080;
      --ft-error-text: #ff8a8a;
      --ft-warning: #fbbf24;
      --ft-link: ${BRAND_ACCENT};
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
