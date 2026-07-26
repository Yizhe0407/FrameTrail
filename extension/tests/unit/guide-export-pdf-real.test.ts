import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import type { StepEntry } from '@/lib/storage/db';

const mocks = vi.hoisted(() => ({
  composite: vi.fn(),
}));

// The per-entry raster pipeline needs a real browser canvas and is covered by
// entry-render tests; everything downstream of it — pagination, wrapping via
// Intl.Segmenter, and REAL pdf-lib assembly — runs unmocked here.
vi.mock('@/lib/export/entry-render', () => ({
  compositeStepEntry: mocks.composite,
}));

import { GUIDE_EXPORT_LIMITS, generateGuidePdf } from '@/lib/export/guide-export';

/**
 * A minimal but fully valid baseline JPEG (1x1 white pixel). pdf-lib parses
 * the JFIF/SOF markers of embedded JPEGs for real, so the bytes must decode —
 * a text placeholder blob would make embedJpg throw.
 */
const TINY_JPEG = Uint8Array.from(
  atob(
    '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0a' +
      'HBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAA' +
      'AAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AVN//2Q==',
  ),
  (char) => char.charCodeAt(0),
);

/**
 * Stands in for OffscreenCanvas in jsdom-less Node: measures 14px per code
 * point (content width 1072px -> 76 code points per line) and rasterizes each
 * finished page to the tiny real JPEG above so pdf-lib embeds genuine bytes.
 */
function stubPdfCanvas(): void {
  const context = {
    fillStyle: '',
    font: '',
    textBaseline: 'top',
    fillRect: vi.fn(),
    fillText: vi.fn(),
    drawImage: vi.fn(),
    measureText: vi.fn((text: string) => ({ width: Array.from(text).length * 14 })),
  };
  class OffscreenCanvasStub {
    constructor(
      readonly width: number,
      readonly height: number,
    ) {}
    getContext() {
      return context;
    }
    async convertToBlob() {
      return new Blob([TINY_JPEG.slice()], { type: 'image/jpeg' });
    }
  }
  vi.stubGlobal('OffscreenCanvas', OffscreenCanvasStub);
  vi.stubGlobal(
    'createImageBitmap',
    vi.fn(async () => ({ width: 1_200, height: 700, close: vi.fn() })),
  );
}

function entry(id: string, order: number, description: string): StepEntry {
  return {
    kind: 'single',
    step: {
      id,
      sessionId: 'session-1',
      order,
      screenshotBlob: new Blob([TINY_JPEG.slice()], { type: 'image/jpeg' }),
      bounds: null,
      devicePixelRatio: 1,
      description,
      url: 'https://example.com/settings',
      timestamp: order,
    },
  } as StepEntry;
}

beforeEach(() => {
  stubPdfCanvas();
  mocks.composite.mockReset().mockResolvedValue(new Blob([TINY_JPEG.slice()], { type: 'image/jpeg' }));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('generateGuidePdf with the real pdf-lib', () => {
  it('produces a loadable A4 PDF with one page per entry across CJK, English, and emoji text', async () => {
    const entries = [
      entry('step-1', 1, '點擊瀏覽器工具列上的擴充功能圖示，開啟設定頁面。'),
      entry('step-2', 2, 'Open the extension settings and enable automatic capture for every tab.'),
      entry('step-3', 3, '完成後按下儲存 ✅ and share the guide 👩‍👩‍👧‍👦 with your team 🚀'),
    ];

    const pdf = await generateGuidePdf(entries, {
      title: '安裝指南 Setup Guide 🚀',
      description: '本指南示範 how mixed-script descriptions survive real PDF assembly.',
    });
    expect(pdf.type).toBe('application/pdf');

    const bytes = new Uint8Array(await pdf.arrayBuffer());
    // %PDF- header proves this is genuine pdf-lib output, not a mock artifact.
    expect(Array.from(bytes.slice(0, 5))).toEqual([0x25, 0x50, 0x44, 0x46, 0x2d]);
    expect(bytes.byteLength).toBeGreaterThan(1_000);
    expect(bytes.byteLength).toBeLessThanOrEqual(GUIDE_EXPORT_LIMITS.maxPdfBytes);

    // pdf-lib must be able to parse its own save() output.
    const loaded = await PDFDocument.load(bytes);
    expect(loaded.getPageCount()).toBe(entries.length);
    for (let index = 0; index < loaded.getPageCount(); index++) {
      const { width, height } = loaded.getPage(index).getSize();
      expect(width).toBeCloseTo(595.28, 2);
      expect(height).toBeCloseTo(841.89, 2);
    }
    expect(mocks.composite).toHaveBeenCalledTimes(entries.length);
  });

  it('emits a single-page PDF for a lone entry and keeps the title page merged with it', async () => {
    const pdf = await generateGuidePdf([entry('step-1', 1, 'Only step')], { title: 'One pager' });

    const loaded = await PDFDocument.load(new Uint8Array(await pdf.arrayBuffer()));
    expect(loaded.getPageCount()).toBe(1);
  });
});
