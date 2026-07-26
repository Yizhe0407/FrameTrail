import { throwIfAborted } from '../shared/abort';
import type { StepEntry } from '../storage/db';
import {
  DEFAULT_DESCRIPTION,
  DEFAULT_TITLE,
  GUIDE_EXPORT_LIMITS,
  GuideExportLimitError,
  IMAGE_MIME_TYPE,
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
    // Blob construction already copies the bytes, and the caller hands us an
    // owned buffer, so no additional defensive copy is needed here.
    const bitmap = await createImageBitmap(new Blob([imageBytes as Uint8Array<ArrayBuffer>], { type: IMAGE_MIME_TYPE }));
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
