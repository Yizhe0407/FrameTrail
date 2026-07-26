import { strFromU8, unzipSync } from 'fflate';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StepEntry } from '@/lib/storage/db';

const mocks = vi.hoisted(() => ({
  composite: vi.fn(),
  pdfCreate: vi.fn(),
  pdfEmbedJpg: vi.fn(),
  pdfAddPage: vi.fn(),
  pdfDrawImage: vi.fn(),
  pdfSave: vi.fn(),
}));

vi.mock('@/lib/export/entry-render', () => ({
  compositeStepEntry: mocks.composite,
}));

vi.mock('pdf-lib', () => ({
  PDFDocument: { create: mocks.pdfCreate },
}));

import {
  GUIDE_EXPORT_LIMITS,
  GuideExportLimitError,
  generateGuideHtml,
  generateGuideMarkdownArchive,
  generateGuidePdf,
  guideExportFilename,
  type GuideExportMetadata,
} from '@/lib/export/guide-export';
import { renderEntryImages } from '@/lib/export/guide-export-render';
import { stubPdfCanvas } from '../setup/pdf-canvas';
import { PERSISTED_STEP_LIMITS } from '@/lib/storage/persistence-limits';

function entry(overrides: Record<string, unknown> = {}): StepEntry {
  return {
    kind: 'single',
    step: {
      id: 'step-1',
      sessionId: 'session-1',
      order: 1,
      screenshotBlob: new Blob(['source'], { type: 'image/jpeg' }),
      bounds: null,
      devicePixelRatio: 1,
      description: 'Open settings',
      url: 'https://example.com/settings',
      timestamp: 1,
      ...overrides,
    },
  } as StepEntry;
}

function groupEntry(): StepEntry {
  return {
    kind: 'group',
    anchor: {
      id: 'anchor',
      sessionId: 'session-1',
      order: 1,
      screenshotBlob: new Blob(['source'], { type: 'image/jpeg' }),
      bounds: null,
      devicePixelRatio: 1,
      description: 'Shared page',
      url: 'https://example.com/shared',
      timestamp: 1,
      groupId: 'anchor',
    },
    annotations: [
      {
        id: 'later',
        sessionId: 'session-1',
        order: 3,
        bounds: { x: 1, y: 1, width: 2, height: 2 },
        devicePixelRatio: 1,
        description: 'Second annotation',
        url: 'https://example.com/shared',
        timestamp: 3,
        groupId: 'anchor',
      },
      {
        id: 'first',
        sessionId: 'session-1',
        order: 2,
        bounds: { x: 1, y: 1, width: 2, height: 2 },
        devicePixelRatio: 1,
        description: 'First annotation',
        url: 'https://example.com/shared',
        timestamp: 2,
        groupId: 'anchor',
      },
    ],
  } as StepEntry;
}

/** Renders the guide's Markdown archive and returns its Markdown document. */
async function archiveMarkdown(entries: StepEntry[], metadata: GuideExportMetadata = {}): Promise<string> {
  const archive = await generateGuideMarkdownArchive(entries, metadata);
  const files = unzipSync(new Uint8Array(await archive.blob.arrayBuffer()));
  return strFromU8(files[archive.markdownFilename]);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

beforeEach(() => {
  mocks.composite.mockReset().mockResolvedValue(new Blob(['annotated'], { type: 'image/jpeg' }));
  mocks.pdfDrawImage.mockReset();
  mocks.pdfEmbedJpg.mockReset().mockResolvedValue({ width: 1, height: 1 });
  mocks.pdfAddPage.mockReset().mockReturnValue({ drawImage: mocks.pdfDrawImage });
  mocks.pdfSave.mockReset().mockResolvedValue(new Uint8Array([0x25, 0x50, 0x44, 0x46]));
  mocks.pdfCreate.mockReset().mockResolvedValue({
    embedJpg: mocks.pdfEmbedJpg,
    addPage: mocks.pdfAddPage,
    save: mocks.pdfSave,
  });
});

describe('guide export', () => {
  it('keeps the persisted-limit-derived export budgets at their established values', () => {
    expect(GUIDE_EXPORT_LIMITS).toEqual({
      maxEntries: 2_000,
      maxImageBytes: 16 * 1024 * 1024,
      maxTotalImageBytes: 64 * 1024 * 1024,
      maxPdfPages: 4_000,
      maxPdfBytes: 128 * 1024 * 1024,
    });
    // The derivation source itself must not drift either.
    expect(PERSISTED_STEP_LIMITS.maxStepsPerGuide).toBe(2_000);
    expect(PERSISTED_STEP_LIMITS.maxScreenshotBytes).toBe(16 * 1024 * 1024);
    expect(PERSISTED_STEP_LIMITS.maxTotalScreenshotBytes).toBe(64 * 1024 * 1024);
  });

  it('uses deterministic, traversal-safe filenames', () => {
    expect(guideExportFilename({ title: '  My / Guide  ' }, 'markdown')).toBe('my-guide.md');
    expect(guideExportFilename({ title: '  My / Guide  ' }, 'markdown-archive')).toBe('my-guide.zip');
    expect(guideExportFilename({ filename: '../../Report 2026' }, 'html')).toBe('report-2026.html');
    expect(guideExportFilename({ filename: '../../Report 2026' }, 'pdf')).toBe('report-2026.pdf');
  });

  it('keeps CJK titles as readable filename stems', () => {
    expect(guideExportFilename({ title: '登入與初始設定' }, 'pdf')).toBe('登入與初始設定.pdf');
    expect(guideExportFilename({ title: 'Chrome 擴充功能：匯出教學' }, 'html')).toBe('chrome-擴充功能-匯出教學.html');
    expect(guideExportFilename({ title: '設定/教學\\範例' }, 'markdown')).toBe('設定-教學-範例.md');
  });

  it('strips filesystem-unsafe characters and falls back for symbol-only titles', () => {
    expect(guideExportFilename({ title: 'a\\b:c*d?e"f<g>h|i' }, 'markdown')).toBe('a-b-c-d-e-f-g-h-i.md');
    expect(guideExportFilename({ title: '  ！？＊  ' }, 'markdown')).toBe('frame-trail-guide.md');
    expect(guideExportFilename({}, 'pdf')).toBe('frame-trail-guide.pdf');
  });

  it('generates a raster PDF without Source, Step, or Annotations labels', async () => {
    const { fillText, bitmapClose } = stubPdfCanvas();

    const pdf = await generateGuidePdf([groupEntry()], { title: 'PDF guide' });
    const drawnText = fillText.mock.calls.map(([text]) => String(text));

    expect(pdf.type).toBe('application/pdf');
    expect(Array.from(new Uint8Array(await pdf.arrayBuffer()))).toEqual([0x25, 0x50, 0x44, 0x46]);
    expect(mocks.composite).toHaveBeenCalledOnce();
    // Hybrid raster: the page background JPEG plus the screenshot embedded as
    // its own image so it keeps native resolution.
    expect(mocks.pdfEmbedJpg).toHaveBeenCalledTimes(2);
    expect(mocks.pdfAddPage).toHaveBeenCalledWith([595.28, 841.89]);
    expect(mocks.pdfDrawImage).toHaveBeenCalledTimes(2);
    const [pagePlacement, screenshotPlacement] = mocks.pdfDrawImage.mock.calls.map(([, placement]) => placement);
    expect(pagePlacement).toEqual({ x: 0, y: 0, width: 595.28, height: 841.89 });
    // The screenshot is layered inside the content area, above the footer.
    expect(screenshotPlacement.x).toBeGreaterThan(0);
    expect(screenshotPlacement.y).toBeGreaterThan(0);
    expect(screenshotPlacement.width).toBeLessThan(595.28);
    expect(screenshotPlacement.height).toBeLessThan(841.89);
    expect(drawnText).toContain('PDF guide');
    expect(drawnText).toContain('Shared page');
    expect(drawnText).toContain('1. ');
    expect(drawnText).toContain('First annotation');
    // Metadata line and running footer.
    expect(drawnText).toContain('共 1 個步驟');
    expect(drawnText).toContain('第 1 頁');
    // The step badge draws only the numeral, never a "Step" label.
    expect(drawnText).toContain('1');
    expect(drawnText).not.toContain('Source');
    expect(drawnText).not.toContain('Step');
    expect(drawnText).not.toContain('Annotations');
    expect(bitmapClose).toHaveBeenCalledOnce();
  });

  it('wraps PDF text at word boundaries instead of splitting English mid-word', async () => {
    const { fillText } = stubPdfCanvas();
    const description = Array.from({ length: 20 }, () => 'documentation').join(' ');

    await generateGuidePdf([entry({ description })], { title: 'T' });

    const lines = fillText.mock.calls.map(([text]) => String(text)).filter((text) => text.includes('documentation'));
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) {
      expect(line).toMatch(/^documentation( documentation)*$/);
      expect(Array.from(line).length).toBeLessThanOrEqual(76);
    }
    expect(lines.join(' ')).toBe(description);
  });

  it('never splits grapheme clusters such as ZWJ emoji when wrapping PDF text', async () => {
    const { fillText } = stubPdfCanvas();
    const cluster = '👩‍👩‍👧‍👦';
    const description = cluster.repeat(30);

    await generateGuidePdf([entry({ description })], { title: 'T' });

    const lines = fillText.mock.calls.map(([text]) => String(text)).filter((text) => text.includes('👩'));
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) {
      expect(line).toMatch(/^(?:👩‍👩‍👧‍👦)+$/u);
    }
    expect(lines.join('')).toBe(description);
  });

  it('wraps long CJK paragraphs without losing or duplicating characters', async () => {
    const { fillText } = stubPdfCanvas();
    const description = '點擊瀏覽器工具列上的擴充功能圖示開啟設定頁面'.repeat(8);

    await generateGuidePdf([entry({ description })], { title: 'T' });

    const lines = fillText.mock.calls.map(([text]) => String(text)).filter((text) => text.includes('點擊'));
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) {
      expect(Array.from(line).length).toBeLessThanOrEqual(76);
    }
    expect(lines.join('')).toBe(description);
  });

  it('packs one Markdown file and every composited image into a portable ZIP', async () => {
    mocks.composite
      .mockResolvedValueOnce(new Blob(['first-image'], { type: 'image/jpeg' }))
      .mockResolvedValueOnce(new Blob(['second-image'], { type: 'image/jpeg' }));

    const archive = await generateGuideMarkdownArchive(
      [entry(), groupEntry()],
      { title: 'Bundle guide', filename: '../../Bundle Guide' },
    );
    const files = unzipSync(new Uint8Array(await archive.blob.arrayBuffer()));
    const markdown = strFromU8(files['bundle-guide.md']);

    expect(archive.blob.type).toBe('application/zip');
    expect(archive.markdownFilename).toBe('bundle-guide.md');
    expect(archive.imageCount).toBe(2);
    expect(Object.keys(files).sort()).toEqual([
      'bundle-guide.md',
      'images/01.jpg',
      'images/02.jpg',
    ]);
    expect(strFromU8(files['images/01.jpg'])).toBe('first-image');
    expect(strFromU8(files['images/02.jpg'])).toBe('second-image');
    expect(markdown).toContain('![Open settings](images/01.jpg)');
    expect(markdown).toContain('![Shared page](images/02.jpg)');
    // Text-first reading order: the description paragraph precedes its image.
    expect(markdown.indexOf('Open settings')).toBeLessThan(markdown.indexOf('![Open settings](images/01.jpg)'));
    expect(markdown.indexOf('Shared page')).toBeLessThan(markdown.indexOf('![Shared page](images/02.jpg)'));
    expect(markdown).not.toContain('Step 1');
    expect(markdown).not.toContain('Step 2');
    expect(markdown).not.toContain('Source:');
    expect(markdown).not.toContain('Annotations:');
    expect(markdown).not.toContain('data:image/');
  });

  it('builds safe Markdown through the shared composite renderer', async () => {
    const markdown = await archiveMarkdown(
      [entry({ description: '<script>alert(1)</script> [link](javascript:alert(1))' })],
      {
        title: '# unsafe',
        description: 'A <b>description</b>',
      },
    );

    expect(mocks.composite).toHaveBeenCalledWith(expect.objectContaining({ kind: 'single' }), 'image/jpeg');
    expect(markdown).toContain('# \\# unsafe');
    expect(markdown).toContain('A \\<b\\>description\\</b\\>');
    expect(markdown).toContain('\\<script\\>alert\\(1\\)\\</script\\>');
    expect(markdown).not.toContain('Source:');
    expect(markdown).not.toContain('https://example.com/settings');

    const credentialHtml = await generateGuideHtml([entry({ url: 'https://user:secret@example.com/private' })]);
    expect(credentialHtml).not.toContain('secret');
  });

  it('escapes user HTML and unsafe URLs in self-contained HTML', async () => {
    const html = await generateGuideHtml(
      [entry({ description: '<img src=x onerror=alert(1)>' })],
      {
        title: '<svg onload=alert(1)>',
        description: '"quoted" & <b>unsafe</b>',
      },
    );

    expect(html).toContain('&lt;svg onload=alert(1)&gt;');
    expect(html).toContain('&quot;quoted&quot; &amp; &lt;b&gt;unsafe&lt;/b&gt;');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html).toContain('src="data:image/jpeg;base64,YW5ub3RhdGVk"');
    expect(html).toContain('http-equiv="Content-Security-Policy"');
    expect(html).toContain("default-src 'none'; img-src data:");
    expect(html.match(/<header class="guide-header">/g)).toHaveLength(1);
    expect(html.match(/<\/header>/g)).toHaveLength(1);
    expect(html).not.toContain('<svg onload=alert(1)>');
    expect(html).not.toContain('<img src=x onerror=alert(1)>');
  });

  it('escapes ordered-list markers and setext underlines in Markdown text', async () => {
    const markdown = await archiveMarkdown(
      [entry({ description: '1. 點擊按鈕\n10. 完成設定' })],
      { title: '版本說明', description: '總覽\n====' },
    );

    expect(markdown).toContain('1\\. 點擊按鈕');
    expect(markdown).toContain('10\\. 完成設定');
    expect(markdown).toContain('\\=\\=\\=\\=');
    expect(markdown).not.toContain('\n1. 點擊按鈕');
    expect(markdown).not.toContain('\n====');
  });

  it('renders repaired section headings in timeline order and escapes Markdown text', async () => {
    const markdown = await archiveMarkdown(
      [entry({ id: 'first', order: 1 }), groupEntry()],
      {
        title: 'Sectioned guide',
        sections: [
          { id: 'later', title: 'Later <chapter>', startEntryId: 'anchor' },
          { id: 'first-section', title: '# First [chapter]', startEntryId: 'first' },
          { id: 'annotation-middle', title: 'Must not render', startEntryId: 'later' },
          { id: 'duplicate-start', title: 'Must also not render', startEntryId: 'first' },
        ],
      },
    );

    const firstHeading = markdown.indexOf('## \\# First \\[chapter\\]');
    const firstImage = markdown.indexOf('![Open settings]');
    const laterHeading = markdown.indexOf('## Later \\<chapter\\>');
    const secondImage = markdown.indexOf('![Shared page]');
    expect(firstHeading).toBeGreaterThan(-1);
    expect(firstHeading).toBeLessThan(firstImage);
    expect(firstImage).toBeLessThan(laterHeading);
    expect(laterHeading).toBeLessThan(secondImage);
    expect(markdown).not.toContain('Must not render');
    expect(markdown).not.toContain('Must also not render');
  });

  it('renders escaped section headings before matching entries in HTML', async () => {
    const metadata = {
      sections: [
        { id: 'section', title: '<img src=x onerror=alert(1)>', startEntryId: 'step-1' },
        { id: 'broken', title: '<script>broken</script>', startEntryId: 'missing' },
      ],
    };
    const html = await generateGuideHtml([entry()], metadata);
    const heading = html.indexOf('&lt;img src=x onerror=alert(1)&gt;');
    const image = html.indexOf('<figure>');

    expect(heading).toBeGreaterThan(-1);
    expect(heading).toBeLessThan(image);
    expect(html).not.toContain('<img src=x onerror=alert(1)>');
    expect(html).not.toContain('broken');
  });

  it('keeps the image above ordered group annotations in HTML', async () => {
    const html = await generateGuideHtml([groupEntry()], { title: 'Guide' });

    const image = html.indexOf('<figure>');
    const annotations = html.indexOf('<div class="annotation-list">');
    expect(image).toBeGreaterThan(-1);
    expect(image).toBeLessThan(annotations);
    expect(html.indexOf('First annotation')).toBeLessThan(html.indexOf('Second annotation'));
    expect(html).not.toContain('Source');
    expect(html).not.toContain('<figcaption>');
    expect(html).not.toContain('Annotated screenshot for step');
    expect(html).not.toContain('Annotations');
    expect(html).not.toContain('<div class="step-index"');
    expect(html).not.toContain('<div class="step-header"');
    expect(html).not.toContain('Step 1');
  });

  it('renders a numbered badge and description heading above each HTML screenshot', async () => {
    const html = await generateGuideHtml([entry(), groupEntry()], { title: 'Guide' });

    const firstBadge = html.indexOf('<span class="step-number" aria-hidden="true">1</span>');
    const firstTitle = html.indexOf('<h3 class="step-title">Open settings</h3>');
    const firstImage = html.indexOf('<figure>');
    expect(firstBadge).toBeGreaterThan(-1);
    expect(firstBadge).toBeLessThan(firstTitle);
    expect(firstTitle).toBeLessThan(firstImage);
    expect(html).toContain('<span class="step-number" aria-hidden="true">2</span>');
    expect(html).toContain('<h3 class="step-title">Shared page</h3>');
  });

  it('renders a title-block metadata line with the step count and optional creation date', async () => {
    const html = await generateGuideHtml([entry()], { title: 'Guide', createdAt: Date.UTC(2026, 6, 26, 12) });
    expect(html).toContain('共 1 個步驟');
    expect(html).toContain('建立於');

    const withoutDate = await generateGuideHtml([entry()], { title: 'Guide' });
    expect(withoutDate).toContain('共 1 個步驟');
    expect(withoutDate).not.toContain('建立於');
  });

  it('propagates shared compositing failures so redaction review remains fail-closed', async () => {
    const privacyError = new Error('Sensitive-information masks must be reviewed before export.');
    mocks.composite.mockRejectedValueOnce(privacyError);

    await expect(generateGuideMarkdownArchive([entry()])).rejects.toBe(privacyError);
    expect(mocks.composite).toHaveBeenCalledTimes(1);
  });

  it('stops after a cancellation between sequential composites', async () => {
    const controller = new AbortController();
    mocks.composite.mockImplementationOnce(async () => {
      controller.abort();
      return new Blob(['annotated'], { type: 'image/jpeg' });
    });

    await expect(
      generateGuideHtml([entry(), entry({ id: 'step-2', order: 2 })], {}, { signal: controller.signal }),
    ).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect(mocks.composite).toHaveBeenCalledTimes(1);
  });

  it('rejects an excessive entry count before compositing any image', async () => {
    const entries = Array.from(
      { length: GUIDE_EXPORT_LIMITS.maxEntries + 1 },
      (_, index) => entry({ id: `step-${index}`, order: index }),
    );

    await expect(generateGuideHtml(entries)).rejects.toBeInstanceOf(GuideExportLimitError);
    expect(mocks.composite).not.toHaveBeenCalled();
  });

  it('rejects an oversized composited image before allocating its ArrayBuffer', async () => {
    const arrayBuffer = vi.fn(async () => new ArrayBuffer(1));
    mocks.composite.mockResolvedValueOnce({
      size: GUIDE_EXPORT_LIMITS.maxImageBytes + 1,
      arrayBuffer,
    } as unknown as Blob);

    await expect(generateGuideMarkdownArchive([entry()])).rejects.toBeInstanceOf(GuideExportLimitError);
    expect(arrayBuffer).not.toHaveBeenCalled();
  });

  it('enforces the cumulative image budget before converting the overflowing image', async () => {
    const arrayBuffer = vi.fn(async () => new ArrayBuffer(1));
    mocks.composite.mockResolvedValue({
      size: GUIDE_EXPORT_LIMITS.maxImageBytes,
      arrayBuffer,
    } as unknown as Blob);
    const entries = Array.from({ length: 5 }, (_, index) => entry({ id: `step-${index}`, order: index }));

    await expect(generateGuideHtml(entries)).rejects.toBeInstanceOf(GuideExportLimitError);
    expect(mocks.composite).toHaveBeenCalledTimes(5);
    expect(arrayBuffer).toHaveBeenCalledTimes(4);
  });

  it('starts the lookahead composite before the consumer drains the current image', async () => {
    const iterator = renderEntryImages([entry(), entry({ id: 'step-2', order: 2 })]);
    const first = await iterator.next();

    // Pipelining contract: while the consumer still holds image 1, image 2 is
    // already compositing — but never more than one ahead (bounded memory).
    expect(first.done).toBe(false);
    expect(mocks.composite).toHaveBeenCalledTimes(2);

    const second = await iterator.next();
    expect(second.done).toBe(false);
    const end = await iterator.next();
    expect(end.done).toBe(true);
    expect(mocks.composite).toHaveBeenCalledTimes(2);
  });

  it('observes a failing lookahead composite when the generator is abandoned early', async () => {
    mocks.composite
      .mockResolvedValueOnce(new Blob(['first'], { type: 'image/jpeg' }))
      .mockRejectedValueOnce(new Error('late compositing failure'));

    const iterator = renderEntryImages([entry(), entry({ id: 'step-2', order: 2 })]);
    const first = await iterator.next();
    expect(first.done).toBe(false);
    await iterator.return(undefined);

    // An unobserved lookahead rejection would surface as an unhandled
    // rejection once the microtask/macrotask queues drain and fail the run.
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

});
