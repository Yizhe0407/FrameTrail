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
  /** Optional stable filename source; extensions are added by guideExportFilename. */
  filename?: string;
  /** Optional chapter headings anchored to complete timeline entry ids. */
  sections?: readonly GuideSection[];
}

export interface GuideExportOptions {
  signal?: AbortSignal;
}

export type GuideExportFormat = 'markdown' | 'markdown-archive' | 'html' | 'pdf';

type GuideExportControl = GuideExportOptions | AbortSignal | undefined;

type RenderedEntryContent = {
  entryId: string;
  ordinal: number;
  description: string;
  annotations: readonly Step[];
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
const DEFAULT_IMAGE_ALT = 'Screenshot';
const DEFAULT_FILENAME = 'frame-trail-guide';
const IMAGE_MIME_TYPE = 'image/jpeg';

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

  const sections = sectionsByStartEntry(metadata.sections, sourceEntries);
  for (const entry of renderedEntries) {
    const section = sections.get(entry.entryId);
    if (section) {
      lines.push('', `## ${escapeGuideMarkdown(section.title)}`);
    }
    const alt = textOrDefault(entry.description, DEFAULT_IMAGE_ALT);
    lines.push('', `![${escapeGuideMarkdown(alt)}](${imageReference(entry)})`);
    appendMarkdownEntryText(lines, entry);
  }

  return `${lines.join('\n')}\n`;
}

/**
 * Generates a self-contained HTML publication. It uses only fixed template
 * markup and data-URI images; all metadata and descriptions pass through
 * text escaping before interpolation.
 */
export async function generateGuideHtml(
  entries: readonly StepEntry[],
  metadata: GuideExportMetadata = {},
  control?: GuideExportControl,
): Promise<string> {
  return generateGuideHtmlDocument(entries, metadata, getSignal(control));
}


/**
 * Generates a local PDF whose pages are rasterized before being embedded. Text
 * is drawn with the browser's installed fonts so CJK descriptions remain
 * visible without shipping a large font file in the extension bundle.
 */
export async function generateGuidePdf(
  entries: readonly StepEntry[],
  metadata: GuideExportMetadata = {},
  control?: GuideExportControl,
): Promise<Blob> {
  const signal = getSignal(control);
  throwIfAborted(signal);
  const { PDFDocument } = await import('pdf-lib');
  throwIfAborted(signal);
  const document = await PDFDocument.create();
  let pageCount = 0;
  let pageImageBytes = 0;
  const paginator = new GuidePdfPaginator(async (jpegBytes) => {
    throwIfAborted(signal);
    pageCount += 1;
    pageImageBytes += jpegBytes.byteLength;
    if (pageCount > GUIDE_EXPORT_LIMITS.maxPdfPages) {
      throw new GuideExportLimitError('Guide PDF exceeds the page limit.');
    }
    if (pageImageBytes > GUIDE_EXPORT_LIMITS.maxPdfBytes) {
      throw new GuideExportLimitError('Guide PDF exceeds the output size limit.');
    }

    const embedded = await document.embedJpg(jpegBytes);
    const page = document.addPage([PDF_PAGE_WIDTH_POINTS, PDF_PAGE_HEIGHT_POINTS]);
    page.drawImage(embedded, {
      x: 0,
      y: 0,
      width: PDF_PAGE_WIDTH_POINTS,
      height: PDF_PAGE_HEIGHT_POINTS,
    });
  }, signal);

  await paginator.addParagraph(textOrDefault(metadata.title, DEFAULT_TITLE), PDF_TITLE_TEXT);
  const guideDescription = textValue(metadata.description);
  if (guideDescription) await paginator.addParagraph(guideDescription, PDF_GUIDE_DESCRIPTION_TEXT);

  const sections = sectionsByStartEntry(metadata.sections, entries);
  let renderedCount = 0;
  for await (const rendered of renderEntryImages(entries, signal)) {
    if (renderedCount > 0) await paginator.startNewPage();
    const section = sections.get(rendered.content.entryId);
    if (section) await paginator.addParagraph(section.title, PDF_SECTION_TEXT);
    await paginator.addImage(rendered.imageBytes);
    await addPdfEntryText(paginator, rendered.content);
    renderedCount += 1;
  }
  await paginator.finish();
  throwIfAborted(signal);

  const saved = await document.save();
  throwIfAborted(signal);
  if (saved.byteLength > GUIDE_EXPORT_LIMITS.maxPdfBytes) {
    throw new GuideExportLimitError('Guide PDF exceeds the output size limit.');
  }
  const owned = new Uint8Array(saved.byteLength);
  owned.set(saved);
  return new Blob([owned.buffer], { type: 'application/pdf' });
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
    for (const [index, annotation] of entry.annotations.entries()) {
      lines.push(`${index + 1}. ${escapeGuideMarkdown(textOrDefault(annotation.description, DEFAULT_DESCRIPTION))}`);
    }
  }
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
    `<div class="guide-overline"><span>FrameTrail Guide</span></div>`,
    `<h1>${escapeGuideHtml(title)}</h1>`,
    description ? `<p class="guide-description">${htmlText(description)}</p>` : '',
  ]
    .filter(Boolean)
    .join('\n');

  const sections = sectionsByStartEntry(metadata.sections, entries);
  const stepChunks: string[] = [];
  for (const entry of renderedEntries) {
    const section = sections.get(entry.entryId);
    if (section) {
      stepChunks.push(renderHtmlSectionHeading(section));
    }
    stepChunks.push(renderHtmlEntry(entry));
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

function renderHtmlEntry(entry: RenderedEntry): string {
  const text = entry.annotations.length === 0
    ? `<p class="step-description">${htmlText(textOrDefault(entry.description, DEFAULT_DESCRIPTION))}</p>`
    : renderHtmlAnnotations(entry);
  const alt = escapeGuideHtml(textOrDefault(entry.description, DEFAULT_IMAGE_ALT));

  return `<section class="guide-step">
<figure>
<img src="${entry.imageDataUri}" alt="${alt}">
</figure>
${text}
</section>`;
}

function renderHtmlAnnotations(entry: RenderedEntry): string {
  const description = textValue(entry.description);
  const intro = description ? `<p class="step-description">${htmlText(description)}</p>\n` : '';
  const items = entry.annotations
    .map((annotation) => `<li>${htmlText(textOrDefault(annotation.description, DEFAULT_DESCRIPTION))}</li>`)
    .join('\n');
  return `${intro}<div class="annotation-list">
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

const PDF_PAGE_WIDTH = 1_240;
const PDF_PAGE_HEIGHT = 1_754;
const PDF_PAGE_WIDTH_POINTS = 595.28;
const PDF_PAGE_HEIGHT_POINTS = 841.89;
const PDF_MARGIN = 84;
const PDF_CONTENT_WIDTH = PDF_PAGE_WIDTH - PDF_MARGIN * 2;
const PDF_FONT_FAMILY = '-apple-system, BlinkMacSystemFont, "Noto Sans TC", "PingFang TC", "Microsoft JhengHei", sans-serif';

type PdfTextStyle = {
  fontSize: number;
  lineHeight: number;
  color: string;
  weight: number;
  gapBefore: number;
  gapAfter: number;
};

const PDF_TITLE_TEXT: PdfTextStyle = {
  fontSize: 54,
  lineHeight: 68,
  color: '#1c1917',
  weight: 750,
  gapBefore: 0,
  gapAfter: 20,
};
const PDF_GUIDE_DESCRIPTION_TEXT: PdfTextStyle = {
  fontSize: 28,
  lineHeight: 44,
  color: '#57534e',
  weight: 400,
  gapBefore: 0,
  gapAfter: 34,
};
const PDF_SECTION_TEXT: PdfTextStyle = {
  fontSize: 38,
  lineHeight: 52,
  color: '#365314',
  weight: 700,
  gapBefore: 0,
  gapAfter: 24,
};
const PDF_BODY_TEXT: PdfTextStyle = {
  fontSize: 28,
  lineHeight: 43,
  color: '#292524',
  weight: 400,
  gapBefore: 0,
  gapAfter: 16,
};
const PDF_LIST_TEXT: PdfTextStyle = {
  ...PDF_BODY_TEXT,
  gapBefore: 10,
  gapAfter: 8,
};

type PdfCanvasContext = OffscreenCanvasRenderingContext2D;

class GuidePdfPaginator {
  private canvas!: OffscreenCanvas;
  private context!: PdfCanvasContext;
  private cursorY = PDF_MARGIN;
  private hasContent = false;

  constructor(
    private readonly emitPage: (jpegBytes: Uint8Array) => Promise<void>,
    private readonly signal?: AbortSignal,
  ) {
    this.resetPage();
  }

  async startNewPage(): Promise<void> {
    if (this.hasContent) await this.flushPage();
  }

  async addParagraph(text: string, style: PdfTextStyle): Promise<void> {
    const normalized = textValue(text).replace(/\r\n?/g, '\n');
    if (!normalized) return;
    this.applyTextStyle(style);
    const lines = wrapPdfText(this.context, normalized, PDF_CONTENT_WIDTH, this.signal);
    let pendingGap = style.gapBefore;

    for (const line of lines) {
      await this.ensureSpace(pendingGap + style.lineHeight);
      this.applyTextStyle(style);
      this.cursorY += pendingGap;
      this.context.fillText(line, PDF_MARGIN, this.cursorY);
      this.cursorY += style.lineHeight;
      this.hasContent = true;
      pendingGap = 0;
    }
    this.cursorY += style.gapAfter;
  }

  async addNumberedParagraph(number: number, text: string): Promise<void> {
    const style = PDF_LIST_TEXT;
    this.applyTextStyle(style);
    const prefix = `${number}. `;
    const prefixWidth = this.context.measureText(prefix).width;
    const lines = wrapPdfText(
      this.context,
      textOrDefault(text, DEFAULT_DESCRIPTION),
      PDF_CONTENT_WIDTH - prefixWidth,
      this.signal,
    );
    let pendingGap = style.gapBefore;

    for (const [index, line] of lines.entries()) {
      await this.ensureSpace(pendingGap + style.lineHeight);
      this.applyTextStyle(style);
      this.cursorY += pendingGap;
      if (index === 0) this.context.fillText(prefix, PDF_MARGIN, this.cursorY);
      this.context.fillText(line, PDF_MARGIN + prefixWidth, this.cursorY);
      this.cursorY += style.lineHeight;
      this.hasContent = true;
      pendingGap = 0;
    }
    this.cursorY += style.gapAfter;
  }

  async addImage(imageBytes: Uint8Array): Promise<void> {
    throwIfAborted(this.signal);
    const ownedImageBytes = new Uint8Array(imageBytes.byteLength);
    ownedImageBytes.set(imageBytes);
    const bitmap = await createImageBitmap(new Blob([ownedImageBytes.buffer], { type: IMAGE_MIME_TYPE }));
    try {
      throwIfAborted(this.signal);
      if (PDF_PAGE_HEIGHT - PDF_MARGIN - this.cursorY < 360) await this.startNewPage();
      const availableHeight = Math.max(320, PDF_PAGE_HEIGHT - PDF_MARGIN - this.cursorY - 220);
      const scale = Math.min(
        PDF_CONTENT_WIDTH / Math.max(1, bitmap.width),
        Math.min(920, availableHeight) / Math.max(1, bitmap.height),
        1,
      );
      const width = Math.max(1, bitmap.width * scale);
      const height = Math.max(1, bitmap.height * scale);
      const x = PDF_MARGIN + (PDF_CONTENT_WIDTH - width) / 2;
      this.context.drawImage(bitmap, x, this.cursorY, width, height);
      this.cursorY += height + 34;
      this.hasContent = true;
    } finally {
      bitmap.close();
    }
  }

  async finish(): Promise<void> {
    if (this.hasContent) await this.flushPage();
  }

  private async ensureSpace(requiredHeight: number): Promise<void> {
    throwIfAborted(this.signal);
    if (this.cursorY + requiredHeight <= PDF_PAGE_HEIGHT - PDF_MARGIN) return;
    await this.startNewPage();
  }

  private applyTextStyle(style: PdfTextStyle): void {
    this.context.font = `${style.weight} ${style.fontSize}px ${PDF_FONT_FAMILY}`;
    this.context.fillStyle = style.color;
    this.context.textBaseline = 'top';
  }

  private async flushPage(): Promise<void> {
    throwIfAborted(this.signal);
    const blob = await this.canvas.convertToBlob({ type: IMAGE_MIME_TYPE, quality: 0.9 });
    throwIfAborted(this.signal);
    await this.emitPage(new Uint8Array(await blob.arrayBuffer()));
    throwIfAborted(this.signal);
    this.resetPage();
  }

  private resetPage(): void {
    if (typeof OffscreenCanvas !== 'function') {
      throw new Error('PDF export is not supported in this browser.');
    }
    this.canvas = new OffscreenCanvas(PDF_PAGE_WIDTH, PDF_PAGE_HEIGHT);
    const context = this.canvas.getContext('2d', { alpha: false });
    if (!context) throw new Error('Unable to create a PDF rendering canvas.');
    this.context = context;
    this.context.fillStyle = '#ffffff';
    this.context.fillRect(0, 0, PDF_PAGE_WIDTH, PDF_PAGE_HEIGHT);
    this.cursorY = PDF_MARGIN;
    this.hasContent = false;
  }
}

async function addPdfEntryText(
  paginator: GuidePdfPaginator,
  entry: RenderedEntryContent,
): Promise<void> {
  if (entry.annotations.length === 0) {
    await paginator.addParagraph(textOrDefault(entry.description, DEFAULT_DESCRIPTION), PDF_BODY_TEXT);
    return;
  }

  const description = textValue(entry.description);
  if (description) await paginator.addParagraph(description, PDF_BODY_TEXT);
  for (const [index, annotation] of entry.annotations.entries()) {
    await paginator.addNumberedParagraph(index + 1, annotation.description);
  }
}

function wrapPdfText(
  context: PdfCanvasContext,
  text: string,
  maxWidth: number,
  signal?: AbortSignal,
): string[] {
  const lines: string[] = [];
  for (const paragraph of text.replace(/\r\n?/g, '\n').split('\n')) {
    if (!paragraph) {
      lines.push('');
      continue;
    }

    let line = '';
    for (const [index, character] of Array.from(paragraph).entries()) {
      if ((index & 255) === 0) throwIfAborted(signal);
      const candidate = `${line}${character}`;
      if (line && context.measureText(candidate).width > maxWidth) {
        lines.push(line.trimEnd());
        line = character.trimStart();
      } else {
        line = candidate;
      }
    }
    lines.push(line);
  }
  return lines.length > 0 ? lines : [''];
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
.guide-section-heading p { margin-bottom: 4px; color: var(--accent); font-size: .72rem; font-weight: 750; letter-spacing: .08em; text-transform: uppercase; }
.guide-section-heading h2 { font-size: 1.65rem; }
.guide-step {
  margin: 0 0 20px;
  padding: 26px;
  border: 1px solid var(--line-soft);
  border-radius: 14px;
  background: var(--surface);
  box-shadow: 0 8px 24px rgb(28 25 23 / 0.045);
}
.step-description { max-width: 72ch; margin-bottom: 16px; color: #292524; white-space: normal; }
.annotation-list { margin-bottom: 18px; padding: 16px 18px; border-left: 3px solid #84cc16; border-radius: 0 8px 8px 0; background: var(--surface-muted); }
figure { margin: 0 0 18px; }
img { display: block; width: auto; max-width: 100%; height: auto; margin-inline: auto; border: 1px solid var(--line); border-radius: 10px; background: var(--canvas); }
@media (max-width: 640px) {
  .guide { width: min(calc(100% - 20px), 1040px); padding: 18px 0 36px; }
  .guide-header { padding: 24px 20px; border-radius: 12px; }
  .guide-overline { align-items: flex-start; flex-direction: column; gap: 4px; }
  .guide-step { padding: 18px 16px; border-radius: 10px; }
}
`;
