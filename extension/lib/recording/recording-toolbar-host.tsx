import { createRoot } from 'react-dom/client';
import RecordingToolbar, { type RecordingToolbarState } from './recording-toolbar';
import { OVERLAY_LAYER, releaseTopLayer, showInTopLayer } from '../capture/overlay-layers';
import { createViewportOverlayHost } from '../capture/viewport-overlay-host';
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
  remove(): void;
}

export function mountRecordingToolbar(
  initialState: RecordingToolbarState,
  options: Options,
): MountedRecordingToolbar {
  // A popover so it shares the top layer with the hover frame and the page's
  // own modals; plain z-index would always lose to either.
  const host = createViewportOverlayHost('data-frametrail-recording-toolbar', { 'pointer-events': 'none' }, { popover: true });

  const shadowRoot = host.attachShadow({ mode: 'closed' });
  const container = document.createElement('div');
  shadowRoot.append(container);
  const root = createRoot(container);
  let removed = false;
  let currentState = initialState;
  let regionCaptureActive = false;

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
      />,
    );
  };

  document.documentElement.append(host);
  showInTopLayer(host, OVERLAY_LAYER.chrome);
  render(initialState);

  return {
    host,
    update: render,
    setRegionCaptureActive(active) {
      if (removed || regionCaptureActive === active) return;
      regionCaptureActive = active;
      render();
    },
    remove() {
      if (removed) return;
      removed = true;
      root.unmount();
      releaseTopLayer(host);
      host.remove();
    },
  };
}
