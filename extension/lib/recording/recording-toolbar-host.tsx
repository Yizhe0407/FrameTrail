import { createRoot } from 'react-dom/client';
import RecordingToolbar, { type RecordingToolbarState } from './recording-toolbar';
import type { RecordingControlMessage, RecordingControlResult } from '@/lib/runtime/messages';

type ToolbarAction = RecordingControlMessage['type'];

interface Options {
  onCommand: (action: ToolbarAction, undoToken?: string) => Promise<RecordingControlResult>;
  onUndoApplied?: () => void;
  onRestoreApplied?: () => void;
  onStartRegionCapture?: () => void;
}

export interface MountedRecordingToolbar {
  host: HTMLElement;
  update(state: RecordingToolbarState): void;
  setRegionCaptureActive(active: boolean): void;
  /** Candidate-cycling copy, rendered inside the toolbar so the affordance
   * never covers page content. */
  setCycleHint(label: string | null): void;
  remove(): void;
}

export function mountRecordingToolbar(
  initialState: RecordingToolbarState,
  options: Options,
): MountedRecordingToolbar {
  const host = document.createElement('div');
  host.setAttribute('data-frametrail-recording-toolbar', '');
  host.style.setProperty('all', 'initial', 'important');
  host.style.setProperty('position', 'fixed', 'important');
  host.style.setProperty('inset', '0', 'important');
  host.style.setProperty('width', '100vw', 'important');
  host.style.setProperty('height', '100vh', 'important');
  host.style.setProperty('pointer-events', 'none', 'important');
  host.style.setProperty('z-index', '2147483647', 'important');

  const shadowRoot = host.attachShadow({ mode: 'closed' });
  const container = document.createElement('div');
  shadowRoot.append(container);
  const root = createRoot(container);
  let removed = false;
  let currentState = initialState;
  let regionCaptureActive = false;
  let cycleHint: string | null = null;

  const render = (state: RecordingToolbarState = currentState) => {
    currentState = state;
    if (removed) return;
    root.render(
      <RecordingToolbar
        state={state}
        onCommand={options.onCommand}
        onUndoApplied={options.onUndoApplied}
        onRestoreApplied={options.onRestoreApplied}
        onStartRegionCapture={options.onStartRegionCapture}
        regionCaptureActive={regionCaptureActive}
        cycleHint={cycleHint}
      />,
    );
  };

  document.documentElement.append(host);
  render(initialState);

  return {
    host,
    update: render,
    setRegionCaptureActive(active) {
      if (removed || regionCaptureActive === active) return;
      regionCaptureActive = active;
      render();
    },
    setCycleHint(label) {
      if (removed || cycleHint === label) return;
      cycleHint = label;
      render();
    },
    remove() {
      if (removed) return;
      removed = true;
      root.unmount();
      host.remove();
    },
  };
}
