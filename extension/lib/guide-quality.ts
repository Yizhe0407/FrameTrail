import type { Bounds, Redaction, Step, StepEntry } from './db';

/** A warning threshold, not a hard limit. Callers may override it per surface. */
export const VERY_LONG_GUIDE_ENTRY_COUNT = 100;

export const ENTRY_QUALITY_ISSUES = [
  'empty-description',
  'duplicate-description',
  'redaction-review-required',
  'missing-image',
  'missing-bounds',
] as const;

export type EntryQualityIssue = (typeof ENTRY_QUALITY_ISSUES)[number];
export type GuideQualityIssue = EntryQualityIssue | 'very-long-guide';
export type GuideEntryKindFilter = 'all' | StepEntry['kind'];
export type GuideEntryIssueFilter = 'all' | 'any' | 'none' | EntryQualityIssue;

export const GUIDE_QUALITY_ISSUE_LABELS: Readonly<Record<GuideQualityIssue, string>> = {
  'empty-description': '缺少說明',
  'duplicate-description': '重複說明',
  'redaction-review-required': '遮罩待確認',
  'missing-image': '缺少可顯示圖片',
  'missing-bounds': '缺少有效框選',
  'very-long-guide': '教學篇幅很長',
};

export interface EntryQualityResult {
  /** Stable timeline id (single step id or snapshot anchor id). */
  entryId: string;
  /** Zero-based position in the supplied entries array. */
  index: number;
  kind: StepEntry['kind'];
  issues: readonly EntryQualityIssue[];
  /** Number of individual description fields or geometry records involved. */
  occurrences: Readonly<Partial<Record<EntryQualityIssue, number>>>;
}

export interface GuideQualityReport {
  entryCount: number;
  descriptionCount: number;
  affectedEntryCount: number;
  totalIssueCount: number;
  isVeryLong: boolean;
  veryLongThreshold: number;
  entries: readonly EntryQualityResult[];
  /** Counts affected entries, which makes these values suitable for filters. */
  issueCounts: Readonly<Record<GuideQualityIssue, number>>;
  /** Counts individual fields/records, useful when one snapshot has many issues. */
  occurrenceCounts: Readonly<Record<GuideQualityIssue, number>>;
  byEntryId: ReadonlyMap<string, EntryQualityResult>;
}

export interface AnalyzeGuideQualityOptions {
  veryLongThreshold?: number;
}

export interface GuideEntryFilters {
  kind?: GuideEntryKindFilter;
  issue?: GuideEntryIssueFilter;
  /** Case-insensitive text. Whitespace-separated terms must all match. */
  text?: string;
  /** Optional multi-issue filtering in addition to `issue`. */
  issues?: readonly EntryQualityIssue[];
  issueMatch?: 'any' | 'all';
}

export interface IndexedGuideEntry {
  entry: StepEntry;
  entryId: string;
  index: number;
  kind: StepEntry['kind'];
  /** Pre-normalized text for repeated searches without rebuilding strings. */
  searchText: string;
  issues: readonly EntryQualityIssue[];
}

export const DEFAULT_GUIDE_ENTRY_FILTERS: Readonly<Required<Pick<GuideEntryFilters, 'kind' | 'issue' | 'text'>>> = {
  kind: 'all',
  issue: 'all',
  text: '',
};

interface MutableEntryQuality {
  entryId: string;
  index: number;
  kind: StepEntry['kind'];
  issues: Set<EntryQualityIssue>;
  occurrences: Partial<Record<EntryQualityIssue, number>>;
}

interface DescriptionReference {
  entryIndex: number;
}

function getEntryId(entry: StepEntry): string {
  return entry.kind === 'single' ? entry.step.id : entry.anchor.id;
}

function getImageOwner(entry: StepEntry): Step {
  return entry.kind === 'single' ? entry.step : entry.anchor;
}

function validBounds(value: unknown): value is Bounds {
  if (!value || typeof value !== 'object') return false;
  const bounds = value as Partial<Bounds>;
  return (
    Number.isFinite(bounds.x) &&
    Number.isFinite(bounds.y) &&
    Number.isFinite(bounds.width) &&
    Number.isFinite(bounds.height) &&
    bounds.width! > 0 &&
    bounds.height! > 0
  );
}

function hasEffectiveBounds(step: Pick<Step, 'bounds' | 'manualBounds'>): boolean {
  return validBounds(step.manualBounds) || validBounds(step.bounds);
}

function validRedaction(value: unknown): value is Redaction {
  if (!value || typeof value !== 'object') return false;
  const redaction = value as Partial<Redaction>;
  return (
    typeof redaction.id === 'string' &&
    redaction.id.trim().length > 0 &&
    redaction.kind === 'solid' &&
    validBounds(redaction.bounds)
  );
}

function privacyReviewRequired(owner: Step): boolean {
  if (owner.redactionReviewRequired === true) return true;
  const raw: unknown = owner.redactions;
  return raw !== undefined && (!Array.isArray(raw) || raw.some((redaction) => !validRedaction(redaction)));
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && value! > 0 ? Math.floor(value!) : fallback;
}

/** Normalization shared by duplicate detection and search. */
export function normalizeGuideText(value: unknown): string {
  return typeof value === 'string' ? value.trim().replace(/\s+/gu, ' ').toLowerCase() : '';
}

/**
 * A cheap fail-closed check for whether a screenshot has bytes to render.
 * It deliberately does not decode, inspect, clone, or read the Blob.
 */
export function hasRenderableImageCandidate(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const size = (value as { size?: unknown }).size;
  return typeof size === 'number' && Number.isFinite(size) && size > 0;
}

function addIssue(target: MutableEntryQuality, issue: EntryQualityIssue, occurrences = 1): void {
  target.issues.add(issue);
  target.occurrences[issue] = (target.occurrences[issue] ?? 0) + occurrences;
}

function descriptionSteps(entry: StepEntry): readonly Step[] {
  // Snapshot anchors are image containers and do not have an editor-side
  // description field; their annotations are the authored instructions.
  return entry.kind === 'single' ? [entry.step] : entry.annotations;
}

/**
 * Performs a shallow, linear quality pass over timeline entries. Complexity is
 * O(entries + annotations + redactions); screenshot bytes are never decoded.
 */
export function analyzeGuideQuality(
  entries: readonly StepEntry[],
  options: AnalyzeGuideQualityOptions = {},
): GuideQualityReport {
  const veryLongThreshold = positiveInteger(options.veryLongThreshold, VERY_LONG_GUIDE_ENTRY_COUNT);
  const mutableEntries: MutableEntryQuality[] = [];
  const duplicateCandidates = new Map<string, DescriptionReference[]>();
  let descriptionCount = 0;

  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    const result: MutableEntryQuality = {
      entryId: getEntryId(entry),
      index,
      kind: entry.kind,
      issues: new Set<EntryQualityIssue>(),
      occurrences: {},
    };
    mutableEntries.push(result);

    const owner = getImageOwner(entry);
    if (!hasRenderableImageCandidate((owner as Partial<Step>).screenshotBlob)) {
      addIssue(result, 'missing-image');
    }

    if (privacyReviewRequired(owner)) {
      addIssue(result, 'redaction-review-required');
    }

    if (entry.kind === 'single') {
      if (!hasEffectiveBounds(entry.step)) addIssue(result, 'missing-bounds');
    } else if (entry.annotations.length === 0) {
      addIssue(result, 'missing-bounds');
    } else {
      let missingBounds = 0;
      for (const annotation of entry.annotations) {
        if (!hasEffectiveBounds(annotation)) missingBounds += 1;
      }
      if (missingBounds > 0) addIssue(result, 'missing-bounds', missingBounds);
    }

    for (const step of descriptionSteps(entry)) {
      descriptionCount += 1;
      const normalized = normalizeGuideText(step.description);
      if (!normalized) {
        addIssue(result, 'empty-description');
        continue;
      }
      const references = duplicateCandidates.get(normalized);
      if (references) references.push({ entryIndex: index });
      else duplicateCandidates.set(normalized, [{ entryIndex: index }]);
    }
  }

  // Each non-empty description is visited at most once again. Repeated text
  // within the same snapshot remains a duplicate and records two occurrences.
  for (const references of duplicateCandidates.values()) {
    if (references.length < 2) continue;
    for (const reference of references) {
      addIssue(mutableEntries[reference.entryIndex], 'duplicate-description');
    }
  }

  const issueCounts = Object.fromEntries(
    [...ENTRY_QUALITY_ISSUES, 'very-long-guide'].map((issue) => [issue, 0]),
  ) as Record<GuideQualityIssue, number>;
  const occurrenceCounts = { ...issueCounts };
  const finalizedEntries: EntryQualityResult[] = [];
  const byEntryId = new Map<string, EntryQualityResult>();
  let affectedEntryCount = 0;
  let totalIssueCount = 0;

  for (const mutable of mutableEntries) {
    const issues = ENTRY_QUALITY_ISSUES.filter((issue) => mutable.issues.has(issue));
    if (issues.length > 0) affectedEntryCount += 1;
    totalIssueCount += issues.length;
    for (const issue of issues) {
      issueCounts[issue] += 1;
      occurrenceCounts[issue] += mutable.occurrences[issue] ?? 0;
    }
    const result: EntryQualityResult = {
      entryId: mutable.entryId,
      index: mutable.index,
      kind: mutable.kind,
      issues,
      occurrences: { ...mutable.occurrences },
    };
    finalizedEntries.push(result);
    byEntryId.set(result.entryId, result);
  }

  const isVeryLong = entries.length >= veryLongThreshold;
  if (isVeryLong) {
    issueCounts['very-long-guide'] = 1;
    occurrenceCounts['very-long-guide'] = 1;
    totalIssueCount += 1;
  }

  return {
    entryCount: entries.length,
    descriptionCount,
    affectedEntryCount,
    totalIssueCount,
    isVeryLong,
    veryLongThreshold,
    entries: finalizedEntries,
    issueCounts,
    occurrenceCounts,
    byEntryId,
  };
}

export function getEntrySearchText(entry: StepEntry): string {
  const owner = getImageOwner(entry);
  const values: unknown[] = [getEntryId(entry), entry.kind, owner.url];
  if (entry.kind === 'single') {
    values.push(entry.step.description);
  } else {
    values.push(entry.anchor.description);
    for (const annotation of entry.annotations) {
      values.push(annotation.id, annotation.description, annotation.url);
    }
  }
  return normalizeGuideText(values.filter((value) => typeof value === 'string').join(' '));
}

export function matchesEntryKind(kind: StepEntry['kind'], filter: GuideEntryKindFilter = 'all'): boolean {
  return filter === 'all' || kind === filter;
}

export function matchesEntryIssues(
  issues: readonly EntryQualityIssue[],
  filter: GuideEntryIssueFilter = 'all',
): boolean {
  if (filter === 'all') return true;
  if (filter === 'any') return issues.length > 0;
  if (filter === 'none') return issues.length === 0;
  return issues.includes(filter);
}

export function matchesEntryText(searchText: string, query: string | undefined): boolean {
  const normalizedQuery = normalizeGuideText(query);
  if (!normalizedQuery) return true;
  const normalizedSearchText = normalizeGuideText(searchText);
  return normalizedQuery.split(' ').every((term) => normalizedSearchText.includes(term));
}

export function createGuideEntryIndex(
  entries: readonly StepEntry[],
  report: GuideQualityReport = analyzeGuideQuality(entries),
): readonly IndexedGuideEntry[] {
  return entries.map((entry, index) => {
    const quality = report.entries[index];
    const id = getEntryId(entry);
    // Index alignment is the allocation-free hot path. The map fallback keeps
    // a caller-provided report safe if it was produced from an equivalent copy.
    const issues = quality?.entryId === id
      ? quality.issues
      : report.byEntryId.get(id)?.issues ?? [];
    return {
      entry,
      entryId: id,
      index,
      kind: entry.kind,
      searchText: getEntrySearchText(entry),
      issues,
    };
  });
}

export function filterGuideEntryIndex(
  index: readonly IndexedGuideEntry[],
  filters: GuideEntryFilters = {},
): readonly IndexedGuideEntry[] {
  const kind = filters.kind ?? 'all';
  const issue = filters.issue ?? 'all';
  const requestedIssues = filters.issues ?? [];
  const issueMatch = filters.issueMatch ?? 'any';
  const normalizedQuery = normalizeGuideText(filters.text);
  const searchTerms = normalizedQuery ? normalizedQuery.split(' ') : [];

  return index.filter((item) => {
    if (!matchesEntryKind(item.kind, kind)) return false;
    if (!matchesEntryIssues(item.issues, issue)) return false;
    if (searchTerms.length > 0 && !searchTerms.every((term) => item.searchText.includes(term))) return false;
    if (requestedIssues.length === 0) return true;
    return issueMatch === 'all'
      ? requestedIssues.every((requested) => item.issues.includes(requested))
      : requestedIssues.some((requested) => item.issues.includes(requested));
  });
}

/** Convenience helper. Build `createGuideEntryIndex` once when filters change often. */
export function filterGuideEntries(
  entries: readonly StepEntry[],
  filters: GuideEntryFilters = {},
  report?: GuideQualityReport,
): readonly StepEntry[] {
  return filterGuideEntryIndex(createGuideEntryIndex(entries, report), filters).map((item) => item.entry);
}
