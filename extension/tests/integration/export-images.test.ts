import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  active: 0,
  maxActive: 0,
  download: vi.fn(),
  composite: vi.fn(async (blob: Blob) => {
    mocks.active++;
    mocks.maxActive = Math.max(mocks.maxActive, mocks.active);
    await Promise.resolve();
    mocks.active--;
    return blob;
  }),
}));

vi.mock('wxt/browser', () => ({ browser: { downloads: { download: mocks.download } } }));
vi.mock('@/lib/annotate', () => ({
  compositeHighlight: mocks.composite,
  compositeMultiHighlight: mocks.composite,
}));

import { exportImagesAsZip, localDateStamp } from '@/lib/export-images';
import type { Step } from '@/lib/db';

function step(order: number): Step {
  return {
    id: String(order),
    sessionId: 'session',
    order,
    screenshotBlob: new Blob([`image-${order}`], { type: 'image/jpeg' }),
    bounds: null,
    devicePixelRatio: 1,
    description: '',
    url: 'https://example.com',
    timestamp: order,
  };
}

beforeEach(() => {
  mocks.active = 0;
  mocks.maxActive = 0;
  mocks.download.mockReset().mockResolvedValue(1);
  mocks.composite.mockClear();
});

afterEach(() => vi.restoreAllMocks());

describe('image export', () => {
  it('formats the filename date in local calendar time', () => {
    expect(localDateStamp(new Date(2026, 0, 2, 0, 5))).toBe('2026-01-02');
  });

  it('composites sequentially and always releases the object URL', async () => {
    const createObjectURL = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:archive');
    const revokeObjectURL = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});

    const result = await exportImagesAsZip([step(0), step(1), step(2)]);

    expect(mocks.composite).toHaveBeenCalledTimes(3);
    expect(mocks.maxActive).toBe(1);
    expect(mocks.download).toHaveBeenCalledWith({
      url: 'blob:archive',
      filename: expect.stringMatching(/^frame-trail-images-\d{4}-\d{2}-\d{2}\.zip$/),
      saveAs: true,
    });
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:archive');
    expect(createObjectURL).toHaveBeenCalledOnce();
    expect(result).toEqual({
      filename: expect.stringMatching(/^frame-trail-images-\d{4}-\d{2}-\d{2}\.zip$/),
      itemCount: 3,
    });
  });

  it('releases the object URL when starting the download fails', async () => {
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:archive');
    const revokeObjectURL = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    mocks.download.mockRejectedValue(new Error('download failed'));

    await expect(exportImagesAsZip([step(0)])).rejects.toThrow('download failed');

    expect(revokeObjectURL).toHaveBeenCalledWith('blob:archive');
  });

  it('stops between image composites when the export is cancelled', async () => {
    const controller = new AbortController();
    mocks.composite.mockImplementationOnce(async (blob: Blob) => {
      controller.abort();
      return blob;
    });

    await expect(exportImagesAsZip([step(0), step(1)], undefined, controller.signal)).rejects.toMatchObject({
      name: 'AbortError',
    });

    expect(mocks.composite).toHaveBeenCalledTimes(1);
    expect(mocks.download).not.toHaveBeenCalled();
  });
});
