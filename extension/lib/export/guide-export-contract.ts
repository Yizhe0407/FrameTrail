import { repairGuideSections, type GuideSection } from '../guide/guide-sections';
import { type StepEntry } from '../storage/models';
import { PERSISTED_STEP_LIMITS } from '../storage/persistence-limits';

export interface GuideExportMetadata {
  /** 未指定 filename 時亦作為檔名來源。 */
  title?: string;
  description?: string;
  /** 副檔名由 guideExportFilename 加入。 */
  filename?: string;
  sections?: readonly GuideSection[];
  /** 僅供顯示的 epoch 毫秒，不影響檔名。 */
  createdAt?: number;
}

export interface GuideExportOptions {
  signal?: AbortSignal;
}

export type GuideExportFormat = 'markdown' | 'markdown-archive' | 'html' | 'pdf';

export interface GuideMarkdownArchive {
  blob: Blob;
  markdownFilename: string;
  imageCount: number;
}

export const DEFAULT_TITLE = 'FrameTrail Guide';
export const DEFAULT_DESCRIPTION = '（未填寫說明）';
export const DEFAULT_IMAGE_ALT = '步驟截圖';
const DEFAULT_FILENAME = 'frame-trail-guide';
export const IMAGE_MIME_TYPE = 'image/jpeg';

/** HTML 螢幕與 PDF 共用主題；HTML 列印仍使用省墨配色。 */
export const GUIDE_EXPORT_THEME = Object.freeze({
  text: '#1d2129',
  secondaryText: '#454d59',
  mutedText: '#6d7585',
  accent: '#3e63c4',
  rule: '#e2e5ea',
  /** Frame around exported screenshots in both documents. Deliberately the
   * PDF's slightly darker #d6dae1 rather than `rule`: an image edge must read
   * against near-white screenshot content, where the hairline value washes out. */
  imageBorder: '#d6dae1',
  /** zh-Hant-first system font stack shared by HTML text and PDF canvas rasterization. */
  fontFamily:
    '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "PingFang TC", "Noto Sans TC", "Microsoft JhengHei", "Helvetica Neue", Arial, sans-serif',
});

/** Derived from the persisted-step limits so every guide accepted by storage
 * remains exportable; PDF budgets carry headroom (spill pages beyond one per
 * step, page rasters on top of the screenshot payload). The image total allows
 * twice the persisted screenshot payload — the same re-encode headroom as the
 * image-ZIP export, because both feed the renderEntryImages pipeline whose
 * annotated re-encodes can exceed their raw sources. */
export const GUIDE_EXPORT_LIMITS = Object.freeze({
  maxEntries: PERSISTED_STEP_LIMITS.maxStepsPerGuide,
  maxImageBytes: PERSISTED_STEP_LIMITS.maxScreenshotBytes,
  maxTotalImageBytes: PERSISTED_STEP_LIMITS.maxTotalScreenshotBytes * 2,
  maxPdfPages: PERSISTED_STEP_LIMITS.maxStepsPerGuide * 2,
  maxPdfBytes: PERSISTED_STEP_LIMITS.maxTotalScreenshotBytes * 2,
});

export class GuideExportLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GuideExportLimitError';
  }
}

/** 產生確定且檔案系統安全的名稱，確保重試結果穩定。 */
export function guideExportFilename(metadata: GuideExportMetadata = {}, format: GuideExportFormat): string {
  const extension = format === 'markdown' ? 'md' : format === 'markdown-archive' ? 'zip' : format;
  return `${filenameStem(metadata)}.${extension}`;
}

/** Escapes text before placing it in generated HTML text or attribute content. */
export function escapeGuideHtml(value: string): string {
  return value.replace(/[&<>'"]/g, (character) => {
    switch (character) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case "'":
        return '&#39;';
      case '"':
        return '&quot;';
      default:
        return character;
    }
  });
}

/**
 * Escapes text for the Markdown constructs emitted by this module. This keeps
 * descriptions and titles text-only instead of allowing them to add links,
 * headings, HTML, or image syntax to the generated guide.
 */
export function escapeGuideMarkdown(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/[[\]()<>`*_#!+\-|{}~=]/g, '\\$&')
    .replace(/\r\n?/g, '\n')
    // `1.` at a line start (up to three spaces of indent) would begin a real
    // ordered list - CommonMark even lets it interrupt a paragraph.
    .replace(/^( {0,3}\d+)\./gm, '$1\\.')
    .replace(/\n/g, '  \n');
}

function filenameStem(metadata: GuideExportMetadata): string {
  const source = textValue(metadata.filename) || textValue(metadata.title);
  const stem = source
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    // Keep every Unicode letter and digit so CJK titles survive as filenames;
    // everything else (separators, punctuation, path and filesystem-unsafe
    // characters, control characters) folds into single dashes.
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '');
  // Bound by code points so truncation can never leave a lone surrogate.
  const bounded = [...stem].slice(0, 96).join('').replace(/-+$/, '');
  return bounded || DEFAULT_FILENAME;
}

/** 時間戳缺少或無效時回傳空字串。 */
export function formatGuideCreatedAt(timestamp: unknown): string {
  if (typeof timestamp !== 'number' || !Number.isFinite(timestamp)) return '';
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return '';
  try {
    return new Intl.DateTimeFormat('zh-Hant', { dateStyle: 'long' }).format(date);
  } catch {
    return date.toISOString().slice(0, 10);
  }
}

export function textValue(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

export function textOrDefault(value: unknown, fallback: string): string {
  const text = textValue(value).trim();
  return text || fallback;
}


export function sectionsByStartEntry(value: unknown, entries: readonly StepEntry[]): Map<string, GuideSection> {
  return new Map(repairGuideSections(value, entries).map((section) => [section.startEntryId, section]));
}
