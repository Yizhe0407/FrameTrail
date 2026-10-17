import { normalizeStoredLine } from './stored-text';

export const PROJECT_TAG_LIMITS = Object.freeze({
  maxTags: 20,
  maxTagLength: 40,
});

/**
 * Tags are display/filter-only, single-line text. Strip every control
 * character (the shared stored-text line rule), trim surrounding whitespace,
 * and cap storage/rendering cost.
 */
export function sanitizeProjectTag(value: unknown): string {
  return typeof value === 'string'
    ? normalizeStoredLine(value).trim().slice(0, PROJECT_TAG_LIMITS.maxTagLength)
    : '';
}
