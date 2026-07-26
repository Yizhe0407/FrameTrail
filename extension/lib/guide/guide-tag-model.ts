export const GUIDE_TAG_LIMITS = Object.freeze({
  maxTags: 20,
  maxTagLength: 40,
});

/**
 * Tags are display/filter-only text. Strip newlines/tabs/nulls, trim
 * surrounding whitespace, and cap storage/rendering cost.
 */
export function sanitizeGuideTag(value: unknown): string {
  return typeof value === 'string'
    ? value.replace(/[\r\n\t\0]/g, '').trim().slice(0, GUIDE_TAG_LIMITS.maxTagLength)
    : '';
}
