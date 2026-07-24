import { strToU8, Zip, ZipPassThrough } from 'fflate';
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

export type GuideExportFormat = 'markdown' | 'markdown-archive' | 'html';

type GuideExportControl = GuideExportOptions | AbortSignal | undefined;

type RenderedEntryContent = {
  entryId: string;
  ordinal: number;
  description: string;
  annotations: readonly Step[];
  sourceUrl: string | null;
};

type RenderedEntry = RenderedEntryContent & {
  imageDataUri: string;
};

type RenderedEntryImage = {
  content: RenderedEntryContent;
  imageBytes: Uint8Array;
};

type RenderedMarkdownEntry = RenderedEntryContent & {
  imageReference: string;
};

export interface GuideMarkdownArchive {
  blob: Blob;
  markdownFilename: string;
  imageCount: number;
}

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
  const extension = format === 'markdown' ? 'md' : format === 'markdown-archive' ? 'zip' : 'html';
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

  return renderGuideMarkdown(renderedEntries, entries, metadata, (entry) => entry.imageDataUri);
}

/**
 * Builds a portable Markdown ZIP containing one Markdown document and every
 * composited guide image under images/. The Markdown uses relative paths so
 * the archive remains editable without embedding large data URIs.
 */
export async function generateGuideMarkdownArchive(
  entries: readonly StepEntry[],
  metadata: GuideExportMetadata = {},
  control?: GuideExportControl,
): Promise<GuideMarkdownArchive> {
  const signal = getSignal(control);
  const markdownEntries: RenderedMarkdownEntry[] = [];
  const markdownFilename = guideExportFilename(metadata, 'markdown');
  const pad = Math.max(2, String(entries.length).length);
  const { archive, result } = createStreamingZip();

  try {
    for await (const rendered of renderEntryImages(entries, signal)) {
      const imageReference = `images/${String(rendered.content.ordinal).padStart(pad, '0')}.jpg`;
      addZipFile(archive, imageReference, rendered.imageBytes);
      markdownEntries.push({ ...rendered.content, imageReference });
    }

    throwIfAborted(signal);
    const markdown = renderGuideMarkdown(
      markdownEntries,
      entries,
      metadata,
      (entry) => entry.imageReference,
    );
    addZipFile(archive, markdownFilename, strToU8(markdown));
    archive.end();
  } catch (error) {
    archive.terminate();
    throw error;
  }

  const blob = await result;
  throwIfAborted(signal);
  return { blob, markdownFilename, imageCount: markdownEntries.length };
}

function renderGuideMarkdown<T extends RenderedEntryContent>(
  renderedEntries: readonly T[],
  sourceEntries: readonly StepEntry[],
  metadata: GuideExportMetadata,
  imageReference: (entry: T) => string,
): string {
  const title = textOrDefault(metadata.title, DEFAULT_TITLE);
  const lines = [`# ${escapeGuideMarkdown(title)}`];
  const description = textValue(metadata.description);
  if (description) lines.push('', escapeGuideMarkdown(description));

  const sourceUrl = safeExternalUrl(metadata.sourceUrl);
  if (sourceUrl) lines.push('', `Source: <${escapeMarkdownUrl(sourceUrl)}>`);

  const sections = sectionsByStartEntry(metadata.sections, sourceEntries);
  let insideSection = false;
  for (const entry of renderedEntries) {
    const section = sections.get(entry.entryId);
    if (section) {
      lines.push('', `## ${escapeGuideMarkdown(section.title)}`);
      insideSection = true;
    }
    lines.push('', `${insideSection ? '###' : '##'} Step ${entry.ordinal}`);
    appendMarkdownEntryText(lines, entry);
    lines.push('', `![${escapeGuideMarkdown(`Step ${entry.ordinal}`)}](${imageReference(entry)})`);
  }

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
  return generateGuideHtmlDocument(entries, metadata, getSignal(control));
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

async function* renderEntryImages(
  entries: readonly StepEntry[],
  signal?: AbortSignal,
): AsyncGenerator<RenderedEntryImage> {
  if (entries.length > GUIDE_EXPORT_LIMITS.maxEntries) {
    throw new GuideExportLimitError('Guide contains too many entries to export safely.');
  }

  let declaredImageBytes = 0;
  let actualImageBytes = 0;

  // Deliberately sequential: a large guide never holds decoded canvases for
  // multiple screenshots while an image is being composited.
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

    const owner = entryOwner(entry);
    yield {
      content: {
        entryId: owner.id,
        ordinal,
        description: textValue(owner.description),
        annotations: sortedAnnotations(entry),
        sourceUrl: safeExternalUrl(owner.url),
      },
      imageBytes: bytes,
    };
  }
}

async function renderEntries(entries: readonly StepEntry[], signal?: AbortSignal): Promise<RenderedEntry[]> {
  const rendered: RenderedEntry[] = [];
  for await (const entry of renderEntryImages(entries, signal)) {
    const imageDataUri = `data:${IMAGE_MIME_TYPE};base64,${encodeBase64(entry.imageBytes, signal)}`;
    throwIfAborted(signal);
    rendered.push({ ...entry.content, imageDataUri });
  }
  return rendered;
}

function appendMarkdownEntryText(lines: string[], entry: RenderedEntryContent): void {
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


function createStreamingZip(): { archive: Zip; result: Promise<Blob> } {
  const chunks: ArrayBuffer[] = [];
  let resolveZip!: (value: Blob) => void;
  let rejectZip!: (reason: unknown) => void;
  const result = new Promise<Blob>((resolve, reject) => {
    resolveZip = resolve;
    rejectZip = reject;
  });

  const archive = new Zip((error, chunk, final) => {
    if (error) {
      rejectZip(error);
      return;
    }
    // fflate may reuse its output buffer after the callback.
    const owned = new Uint8Array(chunk.byteLength);
    owned.set(chunk);
    chunks.push(owned.buffer);
    if (final) resolveZip(new Blob(chunks, { type: 'application/zip' }));
  });

  return { archive, result };
}

function addZipFile(archive: Zip, filename: string, bytes: Uint8Array): void {
  const file = new ZipPassThrough(filename);
  archive.add(file);
  file.push(bytes, true);
}

async function generateGuideHtmlDocument(
  entries: readonly StepEntry[],
  metadata: GuideExportMetadata,
  signal?: AbortSignal,
): Promise<string> {
  const renderedEntries = await renderEntries(entries, signal);
  throwIfAborted(signal);

  const title = textOrDefault(metadata.title, DEFAULT_TITLE);
  const description = textValue(metadata.description);
  const header = [
    `<div class="guide-overline"><span>FrameTrail Guide</span><span>${renderedEntries.length} ${renderedEntries.length === 1 ? 'step' : 'steps'}</span></div>`,
    `<h1>${escapeGuideHtml(title)}</h1>`,
    description ? `<p class="guide-description">${htmlText(description)}</p>` : '',
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
  throwIfAborted(signal);

  return `<!doctype html>
<html lang="zh-Hant">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; object-src 'none'; frame-src 'none'">
<title>${escapeGuideHtml(title)}</title>
<style>
${BASE_STYLE}
</style>
</head>
<body class="guide-document">
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
  const alt = escapeGuideHtml(textOrDefault(entry.description, `Step ${entry.ordinal}`));
  const heading = nested ? 'h3' : 'h2';

  return `<section class="guide-step">
<div class="step-index" aria-hidden="true">${entry.ordinal}</div>
<div class="step-body">
<div class="step-header">
<p>Step</p>
<${heading}>Step ${entry.ordinal}</${heading}>
</div>
<figure>
<img src="${entry.imageDataUri}" alt="${alt}">
</figure>
${text}
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
figure { margin: 20px 0 18px; }
img { display: block; width: auto; max-width: 100%; height: auto; margin-inline: auto; border: 1px solid var(--line); border-radius: 10px; background: var(--canvas); }
@media (max-width: 640px) {
  .guide { width: min(calc(100% - 20px), 1040px); padding: 18px 0 36px; }
  .guide-header { padding: 24px 20px; border-radius: 12px; }
  .guide-overline { align-items: flex-start; flex-direction: column; gap: 4px; }
  .guide-step { grid-template-columns: 36px minmax(0, 1fr); gap: 12px; padding: 18px 16px; border-radius: 10px; }
  .step-index { width: 34px; height: 34px; border-radius: 9px; font-size: .82rem; }
}
`;
