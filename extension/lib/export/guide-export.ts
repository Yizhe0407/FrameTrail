import { encodeBase64 } from './base64';
import { compositeStepEntry } from './entry-render';
import type { Step, StepEntry } from '../storage/db';
import { repairGuideSections, type GuideSection } from '../guide/guide-sections';

/** Metadata that is rendered into a local publication export. */
export interface GuideExportMetadata {
  /** Display title and, when no filename is supplied, the filename source. */
  title?: string;
  /** Optional introductory text for the guide. */
  description?: string;
  /** Optional original page URL shown near the guide title. */
  sourceUrl?: string;
  /** Optional stable filename source; extensions are added by guideExportFilename. */
  filename?: string;
  /** Optional chapter headings anchored to complete timeline entry ids. */
  sections?: readonly GuideSection[];
}

export interface GuideExportOptions {
  signal?: AbortSignal;
}

export type GuideExportFormat = 'markdown' | 'html' | 'print-html';

type GuideExportControl = GuideExportOptions | AbortSignal | undefined;

type RenderedEntry = {
  entryId: string;
  ordinal: number;
  description: string;
  annotations: readonly Step[];
  sourceUrl: string | null;
  imageDataUri: string;
};

const DEFAULT_TITLE = 'FrameTrail Guide';
const DEFAULT_DESCRIPTION = 'No description provided.';
const DEFAULT_FILENAME = 'frame-trail-guide';
const IMAGE_MIME_TYPE = 'image/jpeg';

export const GUIDE_EXPORT_LIMITS = Object.freeze({
  maxEntries: 2_000,
  maxImageBytes: 16 * 1024 * 1024,
  maxTotalImageBytes: 64 * 1024 * 1024,
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
  const extension = format === 'markdown' ? 'md' : 'html';
  const suffix = format === 'print-html' ? '-print' : '';
  return `${filenameStem(metadata)}${suffix}.${extension}`;
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

/**
 * Generates a self-contained Markdown publication. Every image is embedded as
 * a composited JPEG data URI, so the file remains usable without a server or a
 * sibling asset directory.
 */
export async function generateGuideMarkdown(
  entries: readonly StepEntry[],
  metadata: GuideExportMetadata = {},
  control?: GuideExportControl,
): Promise<string> {
  const signal = getSignal(control);
  const renderedEntries = await renderEntries(entries, signal);
  throwIfAborted(signal);

  const title = textOrDefault(metadata.title, DEFAULT_TITLE);
  const lines = [`# ${escapeGuideMarkdown(title)}`];
  const description = textValue(metadata.description);
  if (description) lines.push('', escapeGuideMarkdown(description));

  const sourceUrl = safeExternalUrl(metadata.sourceUrl);
  if (sourceUrl) lines.push('', `Source: <${escapeMarkdownUrl(sourceUrl)}>`);

  const sections = sectionsByStartEntry(metadata.sections, entries);
  let insideSection = false;
  for (const entry of renderedEntries) {
    const section = sections.get(entry.entryId);
    if (section) {
      lines.push('', `## ${escapeGuideMarkdown(section.title)}`);
      insideSection = true;
    }
    lines.push('', `${insideSection ? '###' : '##'} Step ${entry.ordinal}`);
    appendMarkdownEntryText(lines, entry);
    lines.push('', `![${escapeGuideMarkdown(`Step ${entry.ordinal}`)}](${entry.imageDataUri})`);
  }

  throwIfAborted(signal);
  return `${lines.join('\n')}\n`;
}

/**
 * Generates a self-contained HTML publication. It uses only fixed template
 * markup and data-URI images; all metadata, descriptions, and page URLs pass
 * through text/URL escaping before interpolation.
 */
export async function generateGuideHtml(
  entries: readonly StepEntry[],
  metadata: GuideExportMetadata = {},
  control?: GuideExportControl,
): Promise<string> {
  return generateGuideHtmlDocument(entries, metadata, false, getSignal(control));
}

/**
 * Generates a self-contained HTML document with print CSS. Open the returned
 * document in a browser and use its native "Save as PDF" print destination;
 * no PDF library, network request, or browser-extension API is required.
 */
export async function generatePrintReadyGuideHtml(
  entries: readonly StepEntry[],
  metadata: GuideExportMetadata = {},
  control?: GuideExportControl,
): Promise<string> {
  return generateGuideHtmlDocument(entries, metadata, true, getSignal(control));
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

function getSignal(control: GuideExportControl): AbortSignal | undefined {
  if (!control) return undefined;
  return 'aborted' in control ? control : control.signal;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error ? signal.reason : new DOMException('Guide export cancelled', 'AbortError');
}

function textValue(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function textOrDefault(value: unknown, fallback: string): string {
  const text = textValue(value).trim();
  return text || fallback;
}

/** Only rendered HTTP(S) links are safe to place in an HTML href or Markdown URL. */
function safeExternalUrl(value: unknown): string | null {
  const text = textValue(value).trim();
  if (!text || /[\u0000-\u001f\u007f]/.test(text)) return null;

  try {
    const url = new URL(text);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    if (url.username || url.password) return null;
    return url.href;
  } catch {
    return null;
  }
}

function escapeMarkdownUrl(url: string): string {
  // URL() has already rejected control characters and canonicalized unsafe
  // delimiters. Escaping these remaining Markdown delimiters keeps the link
  // destination structural rather than user-controlled markup.
  return url.replace(/[\\<>]/g, '\\$&');
}

function sortedAnnotations(entry: StepEntry): readonly Step[] {
  if (entry.kind === 'single') return [];
  return [...entry.annotations].sort((left, right) => left.order - right.order || left.id.localeCompare(right.id));
}

function entryOwner(entry: StepEntry): Step {
  return entry.kind === 'single' ? entry.step : entry.anchor;
}

function assertGuideImageBudget(imageBytes: number, totalImageBytes: number, ordinal: number): void {
  if (!Number.isSafeInteger(imageBytes) || imageBytes < 0 || imageBytes > GUIDE_EXPORT_LIMITS.maxImageBytes) {
    throw new GuideExportLimitError(`Step ${ordinal} exceeds the per-image guide export limit.`);
  }
  if (totalImageBytes + imageBytes > GUIDE_EXPORT_LIMITS.maxTotalImageBytes) {
    throw new GuideExportLimitError('Guide images exceed the total export limit.');
  }
}

async function renderEntries(entries: readonly StepEntry[], signal?: AbortSignal): Promise<RenderedEntry[]> {
  if (entries.length > GUIDE_EXPORT_LIMITS.maxEntries) {
    throw new GuideExportLimitError('Guide contains too many entries to export safely.');
  }

  const rendered: RenderedEntry[] = [];
  let declaredImageBytes = 0;
  let actualImageBytes = 0;

  // Deliberately sequential: a large guide never holds decoded canvases or
  // base64 copies for multiple screenshots while an image is being composited.
  for (const [index, entry] of entries.entries()) {
    throwIfAborted(signal);
    // This is the single rasterization path used by previews/image exports.
    // In particular, it refuses redaction-review-required entries fail-closed.
    const image = await compositeStepEntry(entry, IMAGE_MIME_TYPE);
    throwIfAborted(signal);
    const ordinal = index + 1;

    // Blob.size is available without allocating another full copy, so reject
    // oversized output before arrayBuffer() and base64's ~4/3 expansion.
    assertGuideImageBudget(image.size, declaredImageBytes, ordinal);
    declaredImageBytes += image.size;
    const bytes = new Uint8Array(await image.arrayBuffer());
    throwIfAborted(signal);
    // Recheck the owned buffer as defense-in-depth for non-native Blob-like
    // implementations used by tests or future adapters.
    assertGuideImageBudget(bytes.byteLength, actualImageBytes, ordinal);
    actualImageBytes += bytes.byteLength;
    const imageDataUri = `data:${IMAGE_MIME_TYPE};base64,${encodeBase64(bytes, signal)}`;
    throwIfAborted(signal);

    const owner = entryOwner(entry);
    rendered.push({
      entryId: owner.id,
      ordinal,
      description: textValue(owner.description),
      annotations: sortedAnnotations(entry),
      sourceUrl: safeExternalUrl(owner.url),
      imageDataUri,
    });
  }

  return rendered;
}

function appendMarkdownEntryText(lines: string[], entry: RenderedEntry): void {
  if (entry.annotations.length === 0) {
    lines.push('', escapeGuideMarkdown(textOrDefault(entry.description, DEFAULT_DESCRIPTION)));
  } else {
    const description = textValue(entry.description);
    if (description) lines.push('', escapeGuideMarkdown(description));
    lines.push('', 'Annotations:');
    for (const [index, annotation] of entry.annotations.entries()) {
      lines.push(`${index + 1}. ${escapeGuideMarkdown(textOrDefault(annotation.description, DEFAULT_DESCRIPTION))}`);
    }
  }

  if (entry.sourceUrl) lines.push('', `Source: <${escapeMarkdownUrl(entry.sourceUrl)}>`);
}

async function generateGuideHtmlDocument(
  entries: readonly StepEntry[],
  metadata: GuideExportMetadata,
  printReady: boolean,
  signal?: AbortSignal,
): Promise<string> {
  const renderedEntries = await renderEntries(entries, signal);
  throwIfAborted(signal);

  const title = textOrDefault(metadata.title, DEFAULT_TITLE);
  const description = textValue(metadata.description);
  const sourceUrl = safeExternalUrl(metadata.sourceUrl);
  const header = [
    `<h1>${escapeGuideHtml(title)}</h1>`,
    description ? `<p class="guide-description">${htmlText(description)}</p>` : '',
    sourceUrl ? `<p class="guide-source">Source: ${htmlLink(sourceUrl)}</p>` : '',
  ]
    .filter(Boolean)
    .join('\n');

  const sections = sectionsByStartEntry(metadata.sections, entries);
  const stepChunks: string[] = [];
  let insideSection = false;
  for (const entry of renderedEntries) {
    const section = sections.get(entry.entryId);
    if (section) {
      stepChunks.push(renderHtmlSectionHeading(section));
      insideSection = true;
    }
    stepChunks.push(renderHtmlEntry(entry, insideSection));
  }
  const steps = stepChunks.join('\n');
  const printClass = printReady ? ' print-ready' : '';
  const printStyle = printReady ? PRINT_STYLE : '';
  throwIfAborted(signal);

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; object-src 'none'; frame-src 'none'">
<title>${escapeGuideHtml(title)}</title>
<style>
${BASE_STYLE}${printStyle}
</style>
</head>
<body class="guide-document${printClass}">
<main class="guide">
<header class="guide-header">
${header}
</header>
${steps}
</main>
</body>
</html>
`;
}

function renderHtmlSectionHeading(section: GuideSection): string {
  return `<section class="guide-section-heading">
<h2>${htmlText(section.title)}</h2>
</section>`;
}

function renderHtmlEntry(entry: RenderedEntry, nested: boolean): string {
  const text = entry.annotations.length === 0
    ? `<p class="step-description">${htmlText(textOrDefault(entry.description, DEFAULT_DESCRIPTION))}</p>`
    : renderHtmlAnnotations(entry, nested);
  const source = entry.sourceUrl ? `<p class="step-source">Source: ${htmlLink(entry.sourceUrl)}</p>` : '';
  const alt = escapeGuideHtml(`Annotated screenshot for step ${entry.ordinal}`);
  const heading = nested ? 'h3' : 'h2';

  return `<section class="guide-step">
<${heading}>Step ${entry.ordinal}</${heading}>
${text}
${source}
<figure>
<img src="${entry.imageDataUri}" alt="${alt}">
<figcaption>Annotated screenshot for step ${entry.ordinal}</figcaption>
</figure>
</section>`;
}

function renderHtmlAnnotations(entry: RenderedEntry, nested: boolean): string {
  const description = textValue(entry.description);
  const intro = description ? `<p class="step-description">${htmlText(description)}</p>\n` : '';
  const items = entry.annotations
    .map((annotation) => `<li>${htmlText(textOrDefault(annotation.description, DEFAULT_DESCRIPTION))}</li>`)
    .join('\n');
  const heading = nested ? 'h4' : 'h3';
  return `${intro}<${heading}>Annotations</${heading}>
<ol>
${items}
</ol>`;
}

function sectionsByStartEntry(value: unknown, entries: readonly StepEntry[]): Map<string, GuideSection> {
  return new Map(repairGuideSections(value, entries).map((section) => [section.startEntryId, section]));
}

function htmlText(value: string): string {
  return escapeGuideHtml(value).replace(/\r\n?|\n/g, '<br>');
}

function htmlLink(url: string): string {
  const escaped = escapeGuideHtml(url);
  return `<a href="${escaped}" target="_blank" rel="noopener noreferrer">${escaped}</a>`;
}

const BASE_STYLE = `
:root { color-scheme: light; font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
* { box-sizing: border-box; }
body { margin: 0; background: #f5f5f4; color: #1c1917; line-height: 1.5; }
.guide { width: min(100% - 32px, 960px); margin: 0 auto; padding: 32px 0 56px; }
.guide-header { border-bottom: 1px solid #d6d3d1; margin-bottom: 28px; padding-bottom: 20px; }
h1, h2, h3, h4 { line-height: 1.2; }
h1 { font-size: 2rem; margin: 0; }
h2 { font-size: 1.35rem; margin: 0 0 12px; }
h3 { font-size: 1rem; margin: 16px 0 8px; }
h4 { font-size: .95rem; margin: 16px 0 8px; }
p { margin: 0 0 12px; }
ol { margin: 0 0 12px; padding-left: 1.5rem; }
.guide-description { color: #57534e; margin-top: 12px; }
.guide-source, .step-source { color: #57534e; font-size: .925rem; overflow-wrap: anywhere; }
.guide-section-heading { border-bottom: 1px solid #d6d3d1; margin: 36px 0 20px; padding-bottom: 8px; }
.guide-section-heading h2 { margin: 0; }
.guide-step { background: #fff; border: 1px solid #e7e5e4; border-radius: 10px; margin: 0 0 24px; padding: 24px; }
figure { margin: 20px 0 0; }
img { background: #e7e5e4; border: 1px solid #d6d3d1; display: block; height: auto; max-width: 100%; }
figcaption { color: #78716c; font-size: .875rem; margin-top: 8px; }
a { color: #1d4ed8; overflow-wrap: anywhere; }
`;

const PRINT_STYLE = `
@page { margin: 16mm; size: auto; }
@media print {
  body { background: #fff; font-size: 10.5pt; }
  .guide { max-width: none; padding: 0; width: 100%; }
  .guide-header { margin-bottom: 14mm; }
  .guide-step { border: 0; break-inside: avoid; margin: 0 0 12mm; padding: 0; page-break-inside: avoid; }
  a { color: inherit; text-decoration: none; }
  img { max-height: 230mm; object-fit: contain; page-break-inside: avoid; }
}
`;
