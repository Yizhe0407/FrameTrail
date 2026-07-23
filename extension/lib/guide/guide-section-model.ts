export interface GuideSection {
  id: string;
  title: string;
  /** Stable id of a complete timeline entry (a single step or snapshot anchor). */
  startEntryId: string;
}

export const GUIDE_SECTION_LIMITS = Object.freeze({
  maxSections: 200,
  maxIdLength: 256,
  maxTitleLength: 200,
});

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/gu;

/**
 * Section titles are display-only text. Remove all control characters (including
 * newlines/tabs), trim surrounding whitespace, and cap storage/rendering cost.
 */
export function sanitizeGuideSectionTitle(value: unknown): string {
  return typeof value === 'string'
    ? value.replace(CONTROL_CHARACTERS, '').trim().slice(0, GUIDE_SECTION_LIMITS.maxTitleLength)
    : '';
}
