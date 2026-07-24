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
    `<div class="guide-overline"><span>FrameTrail Guide</span><span>${renderedEntries.length} ${renderedEntries.length === 1 ? 'step' : 'steps'}</span></div>`,
    `<h1>${escapeGuideHtml(title)}</h1>`,
    description ? `<p class="guide-description">${htmlText(description)}</p>` : '',
    sourceUrl ? `<p class="guide-source"><span>Source</span>${htmlLink(sourceUrl)}</p>` : '',
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
  const printHint = printReady ? PRINT_HINT : '';
  const printStyle = printReady ? PRINT_STYLE : '';
  throwIfAborted(signal);

  return `<!doctype html>
<html lang="zh-Hant">
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
${printHint}
<main class="guide">
<header class="guide-header">
${header}
</header>
<div class="guide-content">
${steps}
</div>
</main>
</body>
</html>
`;
}

function renderHtmlSectionHeading(section: GuideSection): string {
  return `<section class="guide-section-heading">
<p>Section</p>
<h2>${htmlText(section.title)}</h2>
</section>`;
}

function renderHtmlEntry(entry: RenderedEntry, nested: boolean): string {
  const text = entry.annotations.length === 0
    ? `<p class="step-description">${htmlText(textOrDefault(entry.description, DEFAULT_DESCRIPTION))}</p>`
    : renderHtmlAnnotations(entry, nested);
  const source = entry.sourceUrl
    ? `<p class="step-source"><span>Source</span>${htmlLink(entry.sourceUrl)}</p>`
    : '';
  const alt = escapeGuideHtml(`Annotated screenshot for step ${entry.ordinal}`);
  const heading = nested ? 'h3' : 'h2';

  return `<section class="guide-step">
<div class="step-index" aria-hidden="true">${entry.ordinal}</div>
<div class="step-body">
<div class="step-header">
<p>Step</p>
<${heading}>Step ${entry.ordinal}</${heading}>
</div>
${text}
${source}
<figure>
<img src="${entry.imageDataUri}" alt="${alt}">
<figcaption>Annotated screenshot for step ${entry.ordinal}</figcaption>
</figure>
</div>
</section>`;
}

function renderHtmlAnnotations(entry: RenderedEntry, nested: boolean): string {
  const description = textValue(entry.description);
  const intro = description ? `<p class="step-description">${htmlText(description)}</p>\n` : '';
  const items = entry.annotations
    .map((annotation) => `<li>${htmlText(textOrDefault(annotation.description, DEFAULT_DESCRIPTION))}</li>`)
    .join('\n');
  const heading = nested ? 'h4' : 'h3';
  return `${intro}<div class="annotation-list">
<${heading}>Annotations</${heading}>
<ol>
${items}
</ol>
</div>`;
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

const PRINT_HINT = `<aside class="print-hint" aria-label="Print instructions">
<div>
<span class="print-hint-icon" aria-hidden="true">P</span>
<p><strong>Print-ready layout</strong><span>Use your browser’s print command, then choose “Save as PDF”.</span></p>
<kbd>Ctrl / ⌘ + P</kbd>
</div>
</aside>`;

const BASE_STYLE = `
:root {
  color-scheme: light;
  --canvas: #f5f5f4;
  --surface: #ffffff;
  --surface-muted: #fafaf9;
  --text: #1c1917;
  --text-muted: #57534e;
  --line: #d6d3d1;
  --line-soft: #e7e5e4;
  --accent: #4d7c0f;
  --accent-soft: #ecfccb;
  font-family: -apple-system, BlinkMacSystemFont, "Noto Sans TC", "PingFang TC", "Microsoft JhengHei", "Segoe UI", sans-serif;
}
* { box-sizing: border-box; }
html { background: var(--canvas); }
body { margin: 0; background: var(--canvas); color: var(--text); font-size: 16px; line-height: 1.65; }
.guide { width: min(calc(100% - 32px), 1040px); margin: 0 auto; padding: 40px 0 64px; }
.guide-header {
  margin-bottom: 28px;
  padding: 34px 36px;
  overflow: hidden;
  border: 1px solid var(--line-soft);
  border-radius: 16px;
  background: linear-gradient(145deg, #ffffff 0%, #fafaf9 74%, #f7fee7 100%);
  box-shadow: 0 12px 32px rgb(28 25 23 / 0.06);
}
.guide-overline { display: flex; align-items: center; justify-content: space-between; gap: 16px; margin-bottom: 16px; color: var(--accent); font-size: .75rem; font-weight: 750; letter-spacing: .08em; text-transform: uppercase; }
h1, h2, h3, h4 { color: var(--text); line-height: 1.25; text-wrap: balance; }
h1 { max-width: 22ch; margin: 0; font-size: clamp(2rem, 5vw, 3.35rem); letter-spacing: -.035em; }
h2 { margin: 0; font-size: 1.45rem; }
h3 { margin: 0; font-size: 1.2rem; }
h4 { margin: 0; font-size: 1rem; }
p { margin: 0; }
ol { margin: 10px 0 0; padding-left: 1.5rem; }
li { padding-left: .3rem; }
li + li { margin-top: 7px; }
.guide-description { max-width: 68ch; margin-top: 16px; color: var(--text-muted); font-size: 1.05rem; }
.guide-source, .step-source { display: flex; align-items: baseline; gap: 9px; margin-top: 16px; color: var(--text-muted); font-size: .86rem; overflow-wrap: anywhere; }
.guide-source span, .step-source span { flex: 0 0 auto; color: var(--text); font-size: .7rem; font-weight: 750; letter-spacing: .06em; text-transform: uppercase; }
.guide-content { display: flow-root; }
.guide-section-heading { margin: 44px 0 18px; padding: 0 4px 12px; border-bottom: 1px solid var(--line); }
.guide-section-heading p, .step-header p { margin-bottom: 4px; color: var(--accent); font-size: .72rem; font-weight: 750; letter-spacing: .08em; text-transform: uppercase; }
.guide-section-heading h2 { font-size: 1.65rem; }
.guide-step {
  display: grid;
  grid-template-columns: 48px minmax(0, 1fr);
  gap: 18px;
  margin: 0 0 20px;
  padding: 26px;
  border: 1px solid var(--line-soft);
  border-radius: 14px;
  background: var(--surface);
  box-shadow: 0 8px 24px rgb(28 25 23 / 0.045);
}
.step-index { display: flex; width: 44px; height: 44px; align-items: center; justify-content: center; border: 1px solid #bef264; border-radius: 12px; background: var(--accent-soft); color: #365314; font-size: .95rem; font-weight: 800; font-variant-numeric: tabular-nums; }
.step-body { min-width: 0; }
.step-header { margin: 1px 0 14px; }
.step-description { max-width: 72ch; margin-bottom: 16px; color: #292524; white-space: normal; }
.annotation-list { margin-bottom: 18px; padding: 16px 18px; border-left: 3px solid #84cc16; border-radius: 0 8px 8px 0; background: var(--surface-muted); }
.annotation-list h3, .annotation-list h4 { font-size: .9rem; }
figure { margin: 20px 0 0; }
img { display: block; width: auto; max-width: 100%; height: auto; margin-inline: auto; border: 1px solid var(--line); border-radius: 10px; background: var(--canvas); }
figcaption { margin-top: 8px; color: #78716c; font-size: .78rem; }
a { color: #1d4ed8; text-decoration-thickness: 1px; text-underline-offset: 2px; overflow-wrap: anywhere; }
@media (max-width: 640px) {
  .guide { width: min(calc(100% - 20px), 1040px); padding: 18px 0 36px; }
  .guide-header { padding: 24px 20px; border-radius: 12px; }
  .guide-overline { align-items: flex-start; flex-direction: column; gap: 4px; }
  .guide-step { grid-template-columns: 36px minmax(0, 1fr); gap: 12px; padding: 18px 16px; border-radius: 10px; }
  .step-index { width: 34px; height: 34px; border-radius: 9px; font-size: .82rem; }
  .guide-source, .step-source { align-items: flex-start; flex-direction: column; gap: 3px; }
}
`;

const PRINT_STYLE = `
.print-hint { position: sticky; z-index: 10; top: 0; padding: 10px 16px; border-bottom: 1px solid #a8a29e; background: rgb(28 25 23 / .94); color: #fafaf9; backdrop-filter: blur(10px); }
.print-hint > div { display: flex; max-width: 1040px; margin: 0 auto; align-items: center; gap: 12px; }
.print-hint-icon { display: flex; width: 34px; height: 34px; flex: 0 0 auto; align-items: center; justify-content: center; border-radius: 9px; background: #a3e635; color: #1c1917; font-size: .8rem; font-weight: 850; }
.print-hint p { display: flex; min-width: 0; flex: 1; flex-direction: column; line-height: 1.35; }
.print-hint strong { font-size: .86rem; }
.print-hint p span { color: #d6d3d1; font-size: .75rem; }
kbd { flex: 0 0 auto; padding: 6px 9px; border: 1px solid #57534e; border-bottom-width: 2px; border-radius: 6px; background: #292524; color: #fafaf9; font: 700 .72rem/1 ui-monospace, SFMono-Regular, Consolas, monospace; }
body.print-ready { background: #d6d3d1; }
.print-ready .guide { width: min(calc(100% - 32px), 210mm); margin: 32px auto 56px; padding: 16mm; background: #fff; box-shadow: 0 18px 55px rgb(28 25 23 / .18); }
.print-ready .guide-header { padding: 0 0 12mm; border: 0; border-bottom: 1px solid var(--line); border-radius: 0; background: #fff; box-shadow: none; }
@page { margin: 14mm 13mm 16mm; size: auto; }
@media print {
  html, body, body.print-ready { background: #fff; }
  body { font-size: 10pt; line-height: 1.5; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  .print-hint { display: none !important; }
  .guide, .print-ready .guide { width: 100%; max-width: none; margin: 0; padding: 0; box-shadow: none; }
  .guide-header, .print-ready .guide-header { margin-bottom: 9mm; padding: 0 0 8mm; background: transparent; }
  .guide-overline { margin-bottom: 4mm; }
  h1 { max-width: none; font-size: 25pt; }
  .guide-description { margin-top: 4mm; font-size: 10.5pt; }
  .guide-source, .step-source { margin-top: 3mm; font-size: 8pt; }
  .guide-section-heading { break-after: avoid-page; page-break-after: avoid; margin: 10mm 0 4mm; padding: 0 0 3mm; }
  .guide-section-heading h2 { font-size: 16pt; }
  .guide-step { display: grid; grid-template-columns: 9mm minmax(0, 1fr); gap: 4mm; break-inside: auto; page-break-inside: auto; margin: 0 0 9mm; padding: 5mm 0 0; border: 0; border-top: .3mm solid var(--line); border-radius: 0; box-shadow: none; }
  .step-index { width: 8mm; height: 8mm; border-radius: 2.2mm; font-size: 8.5pt; }
  .step-header, h1, h2, h3, h4, p, ol { break-after: avoid-page; page-break-after: avoid; }
  .step-header { margin-bottom: 3mm; }
  .step-description { margin-bottom: 4mm; }
  .annotation-list { margin-bottom: 4mm; padding: 3.5mm 4mm; }
  figure { break-inside: avoid-page; page-break-inside: avoid; margin-top: 4mm; }
  img { max-height: 190mm; border-radius: 2mm; object-fit: contain; }
  figcaption { margin-top: 2mm; font-size: 7.5pt; }
  a { color: inherit; text-decoration: none; }
}
@media (max-width: 640px) {
  .print-hint p span, .print-hint kbd { display: none; }
  .print-ready .guide { width: min(calc(100% - 16px), 210mm); margin: 12px auto 28px; padding: 20px 16px; }
}
`;
