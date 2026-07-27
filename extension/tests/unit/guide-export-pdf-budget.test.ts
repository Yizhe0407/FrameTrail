import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import type { StepEntry } from '@/lib/storage/db';

const mocks = vi.hoisted(() => ({
  composite: vi.fn(),
}));

vi.mock('@/lib/export/entry-render', () => ({
  compositeStepEntry: mocks.composite,
}));

// Shrink only the PDF budgets so the degradation ladder (reuse bytes →
// re-encode → draw into the page raster → fail the export) is reachable with
// kilobyte-sized fixtures instead of the production limits.
const LIMITS = vi.hoisted(() => ({ maxPdfBytes: 60_000, maxPdfPages: 40 }));
vi.mock('@/lib/export/guide-export-contract', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/export/guide-export-contract')>();
  return {
    ...actual,
    GUIDE_EXPORT_LIMITS: {
      ...actual.GUIDE_EXPORT_LIMITS,
      // Getters so tests can retune the budget after the module is loaded.
      get maxPdfBytes() {
        return LIMITS.maxPdfBytes;
      },
      get maxPdfPages() {
        return LIMITS.maxPdfPages;
      },
    },
  };
});

import { GuideExportLimitError } from '@/lib/export/guide-export-contract';
import { generateGuidePdf } from '@/lib/export/guide-export-pdf';
import { stubPdfCanvas } from '../setup/pdf-canvas';

/** Same minimal valid baseline JPEG used by guide-export-pdf-real.test.ts. */
const TINY_JPEG = Uint8Array.from(
  atob(
    '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0a' +
      'HBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAA' +
      'AAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AVN//2Q==',
  ),
  (char) => char.charCodeAt(0),
);

/** Screenshot quality used by prepareScreenshot's re-encode pass; page rasters
 * encode at 0.9 (see PDF_SCREENSHOT_JPEG_QUALITY / PDF_PAGE_RASTER_JPEG_QUALITY). */
const REENCODE_QUALITY = 0.92;

function entry(id: string, order: number): StepEntry {
  return {
    kind: 'single',
    step: {
      id,
      sessionId: 'session-1',
      order,
      screenshotBlob: new Blob([TINY_JPEG.slice()], { type: 'image/jpeg' }),
      bounds: null,
      devicePixelRatio: 1,
      description: `Step ${order}`,
      url: 'https://example.com/settings',
      timestamp: order,
    },
  } as StepEntry;
}

function countJpegStreams(bytes: Uint8Array): number {
  let streams = 0;
  for (let index = 0; index + 2 < bytes.length; index++) {
    if (bytes[index] === 0xff && bytes[index + 1] === 0xd8 && bytes[index + 2] === 0xff) streams += 1;
  }
  return streams;
}

// Larger than the 30 000-byte screenshot budget (maxPdfBytes / 2 on a fresh
// document), so the untouched-bytes fast path is refused and prepareScreenshot
// must re-encode. Never embedded itself, so it need not be a valid JPEG.
const OVERSIZED_SCREENSHOT = new Uint8Array(40_000).fill(0x41);

beforeEach(() => {
  mocks.composite.mockReset().mockResolvedValue(
    new Blob([OVERSIZED_SCREENSHOT.slice()], { type: 'image/jpeg' }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('generateGuidePdf byte-budget degradation', () => {
  it('re-encodes an oversized screenshot and embeds the smaller bytes', async () => {
    stubPdfCanvas({
      pageBlob: new Blob([TINY_JPEG.slice()], { type: 'image/jpeg' }),
      bitmap: { width: 1_200, height: 700 },
      // The re-encode pass (quality 0.92) produces bytes that fit the budget.
      convertToBlob: () => new Blob([TINY_JPEG.slice()], { type: 'image/jpeg' }),
    });

    const pdf = await generateGuidePdf([entry('step-1', 1)], { title: 'Budget' });
    const bytes = new Uint8Array(await pdf.arrayBuffer());

    // The original 40 000-byte capture was replaced, not embedded.
    expect(bytes.byteLength).toBeLessThan(OVERSIZED_SCREENSHOT.byteLength);
    // Hybrid layout intact: page raster + separately embedded screenshot.
    expect(countJpegStreams(bytes)).toBe(2);
    const loaded = await PDFDocument.load(bytes);
    expect(loaded.getPageCount()).toBe(1);
  });

  it('falls back to drawing into the page raster when the re-encode still busts the budget', async () => {
    const context = stubPdfCanvas({
      pageBlob: new Blob([TINY_JPEG.slice()], { type: 'image/jpeg' }),
      bitmap: { width: 1_200, height: 700 },
      convertToBlob: (_canvas, encodeOptions) =>
        encodeOptions?.quality === REENCODE_QUALITY
          ? new Blob([OVERSIZED_SCREENSHOT.slice()], { type: 'image/jpeg' })
          : new Blob([TINY_JPEG.slice()], { type: 'image/jpeg' }),
    });

    const pdf = await generateGuidePdf([entry('step-1', 1)], { title: 'Budget' });
    const bytes = new Uint8Array(await pdf.arrayBuffer());

    // Degraded but exported: only the page raster's JPEG stream remains, and
    // the screenshot was painted into it instead of embedded on top.
    expect(countJpegStreams(bytes)).toBe(1);
    // drawImage receives the 5-arg raster fallback (bitmap + layout rect); the
    // re-encode attempt's own 2x draw also lands on the shared context spy, so
    // assert the raster-fallback call shape explicitly.
    expect(context.drawImage.mock.calls.some((call) => call.length === 5)).toBe(true);
    const loaded = await PDFDocument.load(bytes);
    expect(loaded.getPageCount()).toBe(1);
  });

  it('throws GuideExportLimitError when the page count exceeds maxPdfPages', async () => {
    LIMITS.maxPdfPages = 2;
    try {
      stubPdfCanvas({
        pageBlob: new Blob([TINY_JPEG.slice()], { type: 'image/jpeg' }),
        bitmap: { width: 1_200, height: 700 },
      });
      mocks.composite.mockResolvedValue(new Blob([TINY_JPEG.slice()], { type: 'image/jpeg' }));

      await expect(
        generateGuidePdf([entry('step-1', 1), entry('step-2', 2), entry('step-3', 3)], { title: 'Budget' }),
      ).rejects.toThrow(GuideExportLimitError);
      await expect(
        generateGuidePdf([entry('step-1', 1), entry('step-2', 2), entry('step-3', 3)], { title: 'Budget' }),
      ).rejects.toThrow('page limit');
    } finally {
      LIMITS.maxPdfPages = 40;
    }
  });

  it('throws GuideExportLimitError when committed page bytes exceed maxPdfBytes', async () => {
    // A single page raster larger than the whole document budget must be
    // rejected by the paginator's single enforcement point (before pdf-lib
    // ever sees the bytes), not silently emitted.
    stubPdfCanvas({
      pageBlob: new Blob([new Uint8Array(LIMITS.maxPdfBytes + 1)], { type: 'image/jpeg' }),
      bitmap: { width: 1_200, height: 700 },
    });
    mocks.composite.mockResolvedValue(new Blob([TINY_JPEG.slice()], { type: 'image/jpeg' }));

    await expect(generateGuidePdf([entry('step-1', 1)], { title: 'Budget' })).rejects.toThrow(
      'output size limit',
    );
  });
});
