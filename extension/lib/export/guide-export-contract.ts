import { repairGuideSections, type GuideSection } from '../guide/guide-sections';
import type { StepEntry } from '../storage/db';

/** Metadata that is rendered into a local publication export. */
export interface GuideExportMetadata {
  /** Display title and, when no filename is supplied, the filename source. */
  title?: string;
  /** Optional introductory text for the guide. */
  description?: string;
  /** Optional stable filename source; extensions are added by guideExportFilename. */
  filename?: string;
  /** Optional chapter headings anchored to complete timeline entry ids. */
  sections?: readonly GuideSection[];
}

export interface GuideExportOptions {
  signal?: AbortSignal;
}

export type GuideExportFormat = 'markdown' | 'markdown-archive' | 'html' | 'pdf';

export type GuideExportControl = GuideExportOptions | AbortSignal | undefined;

export interface GuideMarkdownArchive {
  blob: Blob;
  markdownFilename: string;
  imageCount: number;
}

export const DEFAULT_TITLE = 'FrameTrail Guide';
export const DEFAULT_DESCRIPTION = 'No description provided.';
export const DEFAULT_IMAGE_ALT = 'Screenshot';
const DEFAULT_FILENAME = 'frame-trail-guide';
export const IMAGE_MIME_TYPE = 'image/jpeg';

export const GUIDE_EXPORT_LIMITS = Object.freeze({
  maxEntries: 2_000,
  maxImageBytes: 16 * 1024 * 1024,
  maxTotalImageBytes: 64 * 1024 * 1024,
  maxPdfPages: 4_000,
  maxPdfBytes: 128 * 1024 * 1024,
});

export class GuideExportLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GuideExportLimitError';
  }
}

/**
 * Produces a stable, filesystem-safe filename without consulting the clock or
 * the browser. Keeping this deterministic lets callers safely retry/cancel a
 * local export without silently creating a differently named publication.
 */
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
    .replace(/[\[\]()<>`*_#!+\-|{}~]/g, '\\$&')
    .replace(/\r\n?/g, '\n')
    .replace(/\n/g, '  \n');
}

function filenameStem(metadata: GuideExportMetadata): string {
  const source = textValue(metadata.filename) || textValue(metadata.title);
  const stem = source
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 96);
  return stem || DEFAULT_FILENAME;
}

export function getSignal(control: GuideExportControl): AbortSignal | undefined {
  if (!control) return undefined;
  return 'aborted' in control ? control : control.signal;
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error ? signal.reason : new DOMException('Guide export cancelled', 'AbortError');
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
