import type { StepEntry } from './db';
import {
  analyzeGuideQuality,
  type EntryQualityIssue,
  type GuideQualityReport,
} from './guide-quality';

/** Issues that can produce an unsafe or structurally broken publication. */
export const BLOCKING_PUBLICATION_ISSUES = [
  'redaction-review-required',
  'missing-image',
  'missing-bounds',
] as const satisfies readonly EntryQualityIssue[];

export type BlockingPublicationIssue = (typeof BLOCKING_PUBLICATION_ISSUES)[number];

export interface PublicationReadiness {
  report: GuideQualityReport;
  blockingCount: number;
  blockingEntryIds: readonly string[];
  canPublish: boolean;
}

export class PublicationBlockedError extends Error {
  readonly readiness: PublicationReadiness;

  constructor(readiness: PublicationReadiness) {
    super('仍有遮罩、圖片或框選需要修正。');
    this.name = 'PublicationBlockedError';
    this.readiness = readiness;
  }
}

/**
 * Runs the cheap metadata-only publication gate. It never decodes or reads a
 * screenshot Blob; raster exporters still retain their own fail-closed privacy
 * checks so bypassing the editor cannot publish an unreviewed mask.
 */
export function evaluatePublicationReadiness(
  entries: readonly StepEntry[],
): PublicationReadiness {
  const report = analyzeGuideQuality(entries);
  const blockingEntryIds = report.entries
    .filter((entry) => entry.issues.some((issue) =>
      BLOCKING_PUBLICATION_ISSUES.includes(issue as BlockingPublicationIssue),
    ))
    .map((entry) => entry.entryId);
  const blockingCount = BLOCKING_PUBLICATION_ISSUES.reduce(
    (total, issue) => total + report.issueCounts[issue],
    0,
  );
  return {
    report,
    blockingCount,
    blockingEntryIds,
    canPublish: blockingCount === 0,
  };
}

export function assertPublicationReady(
  entries: readonly StepEntry[],
): PublicationReadiness {
  const readiness = evaluatePublicationReadiness(entries);
  if (!readiness.canPublish) throw new PublicationBlockedError(readiness);
  return readiness;
}
