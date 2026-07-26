import { throwIfAborted } from '../shared/abort';
import type { StepEntry } from '../storage/db';
import {
  DEFAULT_DESCRIPTION,
  DEFAULT_TITLE,
  GUIDE_EXPORT_LIMITS,
  GuideExportLimitError,
  IMAGE_MIME_TYPE,
  formatGuideCreatedAt,
  getSignal,
  sectionsByStartEntry,
  textOrDefault,
  textValue,
  type GuideExportControl,
  type GuideExportMetadata,
} from './guide-export-contract';
import { renderEntryImages, type RenderedEntryContent } from './guide-export-render';

/**
 * Generates a local PDF whose pages are rasterized before being embedded. Text
 * is drawn with the browser's installed fonts so CJK descriptions remain
 * visible without shipping a large font file in the extension bundle.
 *
 * Layout: a title block (accent kicker, title, description, metadata line)
 * merged with the first step page, one step per page with a numbered badge
 * heading above a bordered screenshot, and a running footer with the guide
 * title and page number.
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
  const title = textOrDefault(metadata.title, DEFAULT_TITLE);
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
  }, title, signal);

  await paginator.addRule(0, 26, 8, PDF_COLOR_ACCENT, 120);
  await paginator.addParagraph(title, PDF_TITLE_TEXT);
  const guideDescription = textValue(metadata.description);
  if (guideDescription) await paginator.addParagraph(guideDescription, PDF_GUIDE_DESCRIPTION_TEXT);
  const metaParts = [`共 ${entries.length} 個步驟`];
  const createdAt = formatGuideCreatedAt(metadata.createdAt);
  if (createdAt) metaParts.push(`建立於 ${createdAt}`);
  await paginator.addParagraph(metaParts.join(' · '), PDF_META_TEXT);
  await paginator.addRule(0, 34, 2, PDF_COLOR_RULE);

  const sections = sectionsByStartEntry(metadata.sections, entries);
  let renderedCount = 0;
  for await (const rendered of renderEntryImages(entries, signal)) {
    if (renderedCount > 0) await paginator.startNewPage();
    const section = sections.get(rendered.content.entryId);
    if (section) await paginator.addParagraph(section.title, PDF_SECTION_TEXT);
    await paginator.addStepHeading(
      rendered.content.ordinal,
      textOrDefault(rendered.content.description, DEFAULT_DESCRIPTION),
    );
    await paginator.addImage(rendered.imageBytes);
    await addPdfAnnotations(paginator, rendered.content);
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

// A4 rasterized at ~150dpi; embedded 1:1 into A4 point-sized pages.
const PDF_PAGE_WIDTH = 1_240;
const PDF_PAGE_HEIGHT = 1_754;
const PDF_PAGE_WIDTH_POINTS = 595.28;
const PDF_PAGE_HEIGHT_POINTS = 841.89;
const PDF_MARGIN = 84;
const PDF_CONTENT_WIDTH = PDF_PAGE_WIDTH - PDF_MARGIN * 2;
/** Content stops above the footer zone so steps never collide with it. */
const PDF_CONTENT_BOTTOM = PDF_PAGE_HEIGHT - 150;
const PDF_FOOTER_RULE_Y = PDF_PAGE_HEIGHT - 112;
const PDF_FOOTER_TEXT_Y = PDF_PAGE_HEIGHT - 92;
const PDF_STEP_BADGE_SIZE = 56;
const PDF_STEP_BADGE_GAP = 24;
const PDF_FONT_FAMILY = '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang TC", "Noto Sans TC", "Microsoft JhengHei", sans-serif';

const PDF_COLOR_TEXT = '#1d2129';
const PDF_COLOR_SECONDARY = '#454d59';
const PDF_COLOR_MUTED = '#6d7585';
const PDF_COLOR_ACCENT = '#3e63c4';
const PDF_COLOR_RULE = '#e2e5ea';
const PDF_COLOR_IMAGE_BORDER = '#d6dae1';

type PdfTextStyle = {
  fontSize: number;
  lineHeight: number;
  color: string;
  weight: number;
  gapBefore: number;
  gapAfter: number;
};

const PDF_TITLE_TEXT: PdfTextStyle = {
  fontSize: 52,
  lineHeight: 68,
  color: PDF_COLOR_TEXT,
  weight: 750,
  gapBefore: 0,
  gapAfter: 18,
};
const PDF_GUIDE_DESCRIPTION_TEXT: PdfTextStyle = {
  fontSize: 28,
  lineHeight: 48,
  color: PDF_COLOR_SECONDARY,
  weight: 400,
  gapBefore: 0,
  gapAfter: 12,
};
const PDF_META_TEXT: PdfTextStyle = {
  fontSize: 23,
  lineHeight: 36,
  color: PDF_COLOR_MUTED,
  weight: 400,
  gapBefore: 6,
  gapAfter: 18,
};
const PDF_SECTION_TEXT: PdfTextStyle = {
  fontSize: 36,
  lineHeight: 56,
  color: PDF_COLOR_ACCENT,
  weight: 700,
  gapBefore: 0,
  gapAfter: 20,
};
const PDF_STEP_TITLE_TEXT: PdfTextStyle = {
  fontSize: 30,
  lineHeight: 52,
  color: PDF_COLOR_TEXT,
  weight: 650,
  gapBefore: 0,
  gapAfter: 22,
};
const PDF_LIST_TEXT: PdfTextStyle = {
  fontSize: 28,
  lineHeight: 48,
  color: PDF_COLOR_SECONDARY,
  weight: 400,
  gapBefore: 6,
  gapAfter: 6,
};

type PdfCanvasContext = OffscreenCanvasRenderingContext2D;

class GuidePdfPaginator {
  private canvas!: OffscreenCanvas;
  private context!: PdfCanvasContext;
  private cursorY = PDF_MARGIN;
  private hasContent = false;
  private pageNumber = 0;

  constructor(
    private readonly emitPage: (jpegBytes: Uint8Array) => Promise<void>,
    private readonly footerTitle: string,
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

  /**
   * Step heading in the Scribe/Tango convention: a filled circular badge with
   * the step number, and the step description as a bold title beside it.
   */
  async addStepHeading(ordinal: number, text: string): Promise<void> {
    const style = PDF_STEP_TITLE_TEXT;
    this.applyTextStyle(style);
    const indent = PDF_STEP_BADGE_SIZE + PDF_STEP_BADGE_GAP;
    const lines = wrapPdfText(this.context, text, PDF_CONTENT_WIDTH - indent, this.signal);
    let pendingGap = style.gapBefore;
    let isFirstLine = true;

    for (const line of lines) {
      const badgeHeight = isFirstLine ? PDF_STEP_BADGE_SIZE : 0;
      await this.ensureSpace(pendingGap + Math.max(style.lineHeight, badgeHeight));
      this.applyTextStyle(style);
      this.cursorY += pendingGap;
      if (isFirstLine) {
        this.drawStepBadge(ordinal, style.lineHeight);
        this.applyTextStyle(style);
        isFirstLine = false;
      }
      this.context.fillText(line, PDF_MARGIN + indent, this.cursorY);
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

  /** Draws a horizontal rule; the accent variant doubles as the title kicker. */
  async addRule(
    gapBefore: number,
    gapAfter: number,
    thickness: number,
    color: string,
    width: number = PDF_CONTENT_WIDTH,
  ): Promise<void> {
    await this.ensureSpace(gapBefore + thickness);
    this.cursorY += gapBefore;
    this.context.fillStyle = color;
    this.context.fillRect(PDF_MARGIN, this.cursorY, width, thickness);
    this.cursorY += thickness + gapAfter;
    this.hasContent = true;
  }

  async addImage(imageBytes: Uint8Array): Promise<void> {
    throwIfAborted(this.signal);
    // Blob construction already copies the bytes, and the caller hands us an
    // owned buffer, so no additional defensive copy is needed here.
    const bitmap = await createImageBitmap(new Blob([imageBytes as Uint8Array<ArrayBuffer>], { type: IMAGE_MIME_TYPE }));
    try {
      throwIfAborted(this.signal);
      if (PDF_CONTENT_BOTTOM - this.cursorY < 360) await this.startNewPage();
      const availableHeight = Math.max(320, PDF_CONTENT_BOTTOM - this.cursorY - 8);
      const scale = Math.min(
        PDF_CONTENT_WIDTH / Math.max(1, bitmap.width),
        Math.min(1_040, availableHeight) / Math.max(1, bitmap.height),
        1,
      );
      const width = Math.max(1, bitmap.width * scale);
      const height = Math.max(1, bitmap.height * scale);
      const x = PDF_MARGIN + (PDF_CONTENT_WIDTH - width) / 2;
      this.context.drawImage(bitmap, x, this.cursorY, width, height);
      this.context.strokeStyle = PDF_COLOR_IMAGE_BORDER;
      this.context.lineWidth = 2;
      this.context.strokeRect(x - 1, this.cursorY - 1, width + 2, height + 2);
      this.cursorY += height + 30;
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
    if (this.cursorY + requiredHeight <= PDF_CONTENT_BOTTOM) return;
    await this.startNewPage();
  }

  private applyTextStyle(style: PdfTextStyle): void {
    this.context.font = `${style.weight} ${style.fontSize}px ${PDF_FONT_FAMILY}`;
    this.context.fillStyle = style.color;
    this.context.textBaseline = 'top';
    this.context.textAlign = 'left';
  }

  private drawStepBadge(ordinal: number, lineHeight: number): void {
    const radius = PDF_STEP_BADGE_SIZE / 2;
    const centerX = PDF_MARGIN + radius;
    const centerY = this.cursorY + lineHeight / 2;
    const context = this.context;
    context.beginPath();
    context.arc(centerX, centerY, radius, 0, Math.PI * 2);
    context.fillStyle = PDF_COLOR_ACCENT;
    context.fill();
    context.font = `700 26px ${PDF_FONT_FAMILY}`;
    context.fillStyle = '#ffffff';
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    context.fillText(String(ordinal), centerX, centerY);
    context.textAlign = 'left';
    context.textBaseline = 'top';
  }

  /** Running footer: hairline, guide title on the left, page number right. */
  private drawFooter(): void {
    const context = this.context;
    context.fillStyle = PDF_COLOR_RULE;
    context.fillRect(PDF_MARGIN, PDF_FOOTER_RULE_Y, PDF_CONTENT_WIDTH, 2);
    context.font = `400 22px ${PDF_FONT_FAMILY}`;
    context.fillStyle = PDF_COLOR_MUTED;
    context.textBaseline = 'top';
    context.textAlign = 'left';
    const pageLabel = `第 ${this.pageNumber} 頁`;
    const pageLabelWidth = context.measureText(pageLabel).width;
    const maxTitleWidth = Math.max(0, PDF_CONTENT_WIDTH - pageLabelWidth - 40);
    context.fillText(truncatePdfText(context, this.footerTitle, maxTitleWidth), PDF_MARGIN, PDF_FOOTER_TEXT_Y);
    context.fillText(pageLabel, PDF_PAGE_WIDTH - PDF_MARGIN - pageLabelWidth, PDF_FOOTER_TEXT_Y);
  }

  private async flushPage(): Promise<void> {
    throwIfAborted(this.signal);
    this.pageNumber += 1;
    this.drawFooter();
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

async function addPdfAnnotations(
  paginator: GuidePdfPaginator,
  entry: RenderedEntryContent,
): Promise<void> {
  // The entry description is already rendered as the step heading; only group
  // annotations remain to be listed under the screenshot.
  for (const [index, annotation] of entry.annotations.entries()) {
    await paginator.addNumberedParagraph(index + 1, annotation.description);
  }
}

type TextSegmenter = { segment(input: string): Iterable<{ segment: string }> };

const pdfSegmenters: { word?: TextSegmenter; grapheme?: TextSegmenter } =
  typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function'
    ? {
        word: new Intl.Segmenter(undefined, { granularity: 'word' }),
        grapheme: new Intl.Segmenter(undefined, { granularity: 'grapheme' }),
      }
    : {};

function segmentPdfText(text: string, granularity: 'word' | 'grapheme'): string[] {
  const segmenter = pdfSegmenters[granularity];
  if (segmenter) return Array.from(segmenter.segment(text), (part) => part.segment);
  // Per-code-point fallback for runtimes without Intl.Segmenter.
  return Array.from(text);
}

/** Shortens footer text with an ellipsis, never splitting a grapheme cluster. */
function truncatePdfText(context: PdfCanvasContext, text: string, maxWidth: number): string {
  if (context.measureText(text).width <= maxWidth) return text;
  const ellipsis = '…';
  let result = '';
  for (const grapheme of segmentPdfText(text, 'grapheme')) {
    if (context.measureText(result + grapheme + ellipsis).width > maxWidth) break;
    result += grapheme;
  }
  return result + ellipsis;
}

/**
 * Greedy line wrapping against measured widths. Breaks at word boundaries
 * first (Intl.Segmenter also dictionary-segments CJK), and only splits a
 * segment wider than a whole line at grapheme-cluster boundaries, so English
 * words are not chopped mid-word and emoji/combining sequences never split
 * into broken glyphs.
 */
function wrapPdfText(
  context: PdfCanvasContext,
  text: string,
  maxWidth: number,
  signal?: AbortSignal,
): string[] {
  const lines: string[] = [];
  let steps = 0;
  const poll = () => {
    if ((steps++ & 255) === 0) throwIfAborted(signal);
  };

  for (const paragraph of text.replace(/\r\n?/g, '\n').split('\n')) {
    if (!paragraph) {
      lines.push('');
      continue;
    }

    let line = '';
    for (const word of segmentPdfText(paragraph, 'word')) {
      poll();
      const candidate = `${line}${word}`;
      if (context.measureText(candidate).width <= maxWidth) {
        line = candidate;
        continue;
      }
      const wrapped = word.trimStart();
      if (line && context.measureText(wrapped).width <= maxWidth) {
        lines.push(line.trimEnd());
        line = wrapped;
        continue;
      }
      // Wider than a whole line: split it, but never inside a grapheme cluster.
      for (const grapheme of segmentPdfText(word, 'grapheme')) {
        poll();
        const graphemeCandidate = `${line}${grapheme}`;
        if (line && context.measureText(graphemeCandidate).width > maxWidth) {
          lines.push(line.trimEnd());
          line = grapheme.trimStart();
        } else {
          line = graphemeCandidate;
        }
      }
    }
    lines.push(line.trimEnd());
  }
  return lines.length > 0 ? lines : [''];
}
