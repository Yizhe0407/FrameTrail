import { browser } from 'wxt/browser';
import { validatePreparedPermissionSource } from './continuation-tabs';
import { MULTI_ANNOTATION_RECAPTURE_BLOCKED } from './editor-messages';
import {
  isPreflightGuideContinuationSourcePermissionResult,
  isPreflightStepRecaptureSourcePermissionResult,
  isStartRecordingResult,
  isStartStepRecaptureResult,
  requireRuntimeMessageResult,
} from '../runtime/runtime-message-result';
import type {
  PreflightGuideContinuationSourcePermissionResult,
  PreflightStepRecaptureSourcePermissionResult,
  StartRecordingMessage,
  StartRecordingResult,
  StartStepRecaptureResult,
} from '../runtime/messages';
import type { StepRecaptureTarget } from '../storage/recording-state';
import type { PreparedCapturePermission } from './editor-app-model';
import type { StepEntry } from '../storage/models';

/**
 * The editor's request layer for source-permission preflights and run starts.
 *
 * It holds no React state: every function either returns a validated
 * PreparedCapturePermission or throws an already-localized Error, leaving the
 * permission-flow hook to own generation/lock bookkeeping and error surfacing.
 */

/** Which capture a recapture run would replace for the selected entry. */
export function recaptureTargetForEntry(entry: StepEntry): StepRecaptureTarget {
  if (entry.kind === 'single') return { kind: 'single', stepId: entry.step.id };
  // Replacing the base image of a multi-annotation snapshot would invalidate
  // every other annotation on it, so that case is refused outright.
  if (entry.annotations.length !== 1) throw new Error(MULTI_ANNOTATION_RECAPTURE_BLOCKED);
  return {
    kind: 'snapshot-singleton',
    anchorId: entry.anchor.id,
    annotationId: entry.annotations[0].id,
  };
}

export async function requestRecapturePreflight(
  sessionId: string,
  target: StepRecaptureTarget,
  targetEntryId: string,
): Promise<PreparedCapturePermission> {
  const result = requireRuntimeMessageResult<PreflightStepRecaptureSourcePermissionResult>(
    await browser.runtime.sendMessage({
      type: 'PREFLIGHT_STEP_RECAPTURE_SOURCE_PERMISSION',
      sessionId,
      target,
    }),
    isPreflightStepRecaptureSourcePermissionResult,
  );
  if (!result.ok) throw new Error(result.message);
  validatePreparedPermissionSource(result.sourceOrigin, result.permissionPattern);
  return {
    source: {
      kind: 'origin',
      sourceOrigin: result.sourceOrigin,
      permissionPattern: result.permissionPattern,
      sourceUrl: result.sourceUrl,
    },
    entryId: targetEntryId,
    action: { kind: 'recapture', target },
  };
}

export async function requestContinuationPreflight(
  sessionId: string,
): Promise<PreparedCapturePermission> {
  const result = requireRuntimeMessageResult<PreflightGuideContinuationSourcePermissionResult>(
    await browser.runtime.sendMessage({
      type: 'PREFLIGHT_GUIDE_CONTINUATION_SOURCE_PERMISSION',
      sessionId,
    }),
    isPreflightGuideContinuationSourcePermissionResult,
  );
  if (!result.ok) {
    // A Guide without steps has no source page to lock onto. That is not a
    // terminal error: the dialog still opens and offers the site-agnostic
    // 「改在其他頁面接續」 path, which needs no stored source.
    if (result.code !== 'SOURCE_NOT_FOUND') throw new Error(result.message);
    return {
      source: { kind: 'unavailable', reason: result.message },
      entryId: null,
      action: { kind: 'continuation' },
    };
  }
  validatePreparedPermissionSource(result.sourceOrigin, result.permissionPattern);
  return {
    source: {
      kind: 'origin',
      sourceOrigin: result.sourceOrigin,
      permissionPattern: result.permissionPattern,
      sourceUrl: result.sourceUrl,
    },
    entryId: null,
    action: { kind: 'continuation' },
  };
}

export async function startRecordingOrThrow(message: StartRecordingMessage): Promise<void> {
  const started = requireRuntimeMessageResult<StartRecordingResult>(
    await browser.runtime.sendMessage(message),
    isStartRecordingResult,
  );
  if (!started.ok) throw new Error(started.error);
}

export async function startStepRecaptureOrThrow(
  sessionId: string,
  target: StepRecaptureTarget,
): Promise<void> {
  const result = requireRuntimeMessageResult<StartStepRecaptureResult>(
    await browser.runtime.sendMessage({ type: 'START_STEP_RECAPTURE', sessionId, target }),
    isStartStepRecaptureResult,
  );
  if (!result.ok) throw new Error(result.error);
}
