import { strFromU8, unzipSync } from 'fflate';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { StepEntry } from '@/lib/storage/db';

const mocks = vi.hoisted(() => ({
  composite: vi.fn(),
}));

vi.mock('@/lib/export/entry-render', () => ({
  compositeStepEntry: mocks.composite,
}));

import {
  GUIDE_EXPORT_LIMITS,
  GuideExportLimitError,
  generateGuideHtml,
  generateGuideMarkdown,
  generateGuideMarkdownArchive,
  guideExportFilename,
} from '@/lib/export/guide-export';

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

beforeEach(() => {
  mocks.composite.mockReset().mockResolvedValue(new Blob(['annotated'], { type: 'image/jpeg' }));
});

describe('guide export', () => {
  it('uses deterministic, traversal-safe filenames', () => {
    expect(guideExportFilename({ title: '  My / Guide  ' }, 'markdown')).toBe('my-guide.md');
    expect(guideExportFilename({ title: '  My / Guide  ' }, 'markdown-archive')).toBe('my-guide.zip');
    expect(guideExportFilename({ filename: '../../Report 2026' }, 'html')).toBe('report-2026.html');
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
    expect(markdown).toContain('![Step 1](images/01.jpg)');
    expect(markdown).toContain('![Step 2](images/02.jpg)');
    expect(markdown).not.toContain('data:image/');
  });

  it('builds safe self-contained Markdown through the shared composite renderer', async () => {
    const markdown = await generateGuideMarkdown(
      [entry({ description: '<script>alert(1)</script> [link](javascript:alert(1))' })],
      {
        title: '# unsafe',
        description: 'A <b>description</b>',
        sourceUrl: 'javascript:alert(1)',
      },
    );

    expect(mocks.composite).toHaveBeenCalledWith(expect.objectContaining({ kind: 'single' }), 'image/jpeg');
    expect(markdown).toContain('# \\# unsafe');
    expect(markdown).toContain('A \\<b\\>description\\</b\\>');
    expect(markdown).toContain('\\<script\\>alert\\(1\\)\\</script\\>');
    expect(markdown).toContain('data:image/jpeg;base64,YW5ub3RhdGVk');
    expect(markdown).not.toContain('Source: <javascript:');

    const credentialHtml = await generateGuideHtml([entry({ url: 'https://user:secret@example.com/private' })], {
      sourceUrl: 'https://admin:token@example.com/private',
    });
    expect(credentialHtml).not.toContain('secret');
    expect(credentialHtml).not.toContain('token');
  });

  it('escapes user HTML and unsafe URLs in self-contained HTML', async () => {
    const html = await generateGuideHtml(
      [entry({ description: '<img src=x onerror=alert(1)>' })],
      {
        title: '<svg onload=alert(1)>',
        description: '"quoted" & <b>unsafe</b>',
        sourceUrl: 'https://example.com/?q=<unsafe>&x=1',
      },
    );

    expect(html).toContain('&lt;svg onload=alert(1)&gt;');
    expect(html).toContain('&quot;quoted&quot; &amp; &lt;b&gt;unsafe&lt;/b&gt;');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html).not.toContain('https://example.com/?q=');
    expect(html).toContain('src="data:image/jpeg;base64,YW5ub3RhdGVk"');
    expect(html).toContain('http-equiv="Content-Security-Policy"');
    expect(html).toContain("default-src 'none'; img-src data:");
    expect(html.match(/<header class="guide-header">/g)).toHaveLength(1);
    expect(html.match(/<\/header>/g)).toHaveLength(1);
    expect(html).not.toContain('<svg onload=alert(1)>');
    expect(html).not.toContain('<img src=x onerror=alert(1)>');
  });

  it('renders repaired section headings in timeline order and escapes Markdown text', async () => {
    const markdown = await generateGuideMarkdown(
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
    const firstStep = markdown.indexOf('### Step 1');
    const laterHeading = markdown.indexOf('## Later \\<chapter\\>');
    const secondStep = markdown.indexOf('### Step 2');
    expect(firstHeading).toBeGreaterThan(-1);
    expect(firstHeading).toBeLessThan(firstStep);
    expect(firstStep).toBeLessThan(laterHeading);
    expect(laterHeading).toBeLessThan(secondStep);
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
    const step = html.indexOf('<h3>Step 1</h3>');

    expect(heading).toBeGreaterThan(-1);
    expect(heading).toBeLessThan(step);
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
  });

  it('propagates shared compositing failures so redaction review remains fail-closed', async () => {
    const privacyError = new Error('Sensitive-information masks must be reviewed before export.');
    mocks.composite.mockRejectedValueOnce(privacyError);

    await expect(generateGuideMarkdown([entry()])).rejects.toBe(privacyError);
    expect(mocks.composite).toHaveBeenCalledTimes(1);
  });

  it('stops after a cancellation between sequential composites', async () => {
    const controller = new AbortController();
    mocks.composite.mockImplementationOnce(async () => {
      controller.abort();
      return new Blob(['annotated'], { type: 'image/jpeg' });
    });

    await expect(generateGuideHtml([entry(), entry({ id: 'step-2', order: 2 })], {}, controller.signal)).rejects.toMatchObject({
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

    await expect(generateGuideMarkdown([entry()])).rejects.toBeInstanceOf(GuideExportLimitError);
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

});
