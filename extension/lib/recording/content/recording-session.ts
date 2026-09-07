import type { RegionCapture } from '../../capture/region-capture';
import type { StepGestureQueue } from '../../capture/step-gesture-queue';
import type { MountedRecordingToolbar } from '../recording-toolbar-host';
import type { SnapshotShield } from '../snapshot-shield';
import type { StepHoverPreview } from '../step-hover-preview';

/**
 * The mutable handles one content-script recording run shares between the
 * entrypoint's lifecycle spine and the per-mode recorders.
 *
 * It exists because teardown, the recording-state subscription, the shield
 * callbacks and the mode recorders all have to reach the same shield, toolbar,
 * hover preview and gesture queue. Threading those as in/out parameters
 * through every installer is what kept the whole run inlined in one closure.
 * Ownership stays with the entrypoint: recorders publish the instances they
 * create here, and only the entrypoint's cleanup disposes of them.
 */
export interface ContentRecordingSession {
  readonly runId: string;
  /** Whether captures are numbered, mirrored from the run's recording state. */
  readonly numbered: boolean;
  /** True while the run is paused; recorders read it to drop input. */
  paused: boolean;
  shield: SnapshotShield | null;
  regionCapture: RegionCapture | null;
  toolbar: MountedRecordingToolbar | null;
  hoverPreview: StepHoverPreview | null;
  gestureQueue: StepGestureQueue | null;
}

export function createContentRecordingSession(options: {
  runId: string;
  numbered: boolean;
  paused: boolean;
}): ContentRecordingSession {
  return {
    runId: options.runId,
    numbered: options.numbered,
    paused: options.paused,
    shield: null,
    regionCapture: null,
    toolbar: null,
    hoverPreview: null,
    gestureQueue: null,
  };
}
