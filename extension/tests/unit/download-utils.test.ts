// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';
import { downloadBlob } from '@/lib/export/download-utils';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('download utilities', () => {
  it('downloads through a temporary anchor and revokes the object URL after a bounded lease', async () => {
    vi.useFakeTimers();
    const createObjectURL = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:guide');
    const revokeObjectURL = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});

    await downloadBlob(new Blob(['guide']), 'guide.md');

    expect(createObjectURL).toHaveBeenCalledOnce();
    expect(click).toHaveBeenCalledOnce();
    expect(revokeObjectURL).not.toHaveBeenCalled();
    await vi.runAllTimersAsync();
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:guide');
    vi.useRealTimers();
    expect(document.querySelector('a[download="guide.md"]')).toBeNull();
  });

  it('does not allocate an object URL when already aborted', async () => {
    const createObjectURL = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:unused');
    const controller = new AbortController();
    controller.abort();

    await expect(downloadBlob(new Blob(['guide']), 'guide.md', { signal: controller.signal })).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect(createObjectURL).not.toHaveBeenCalled();
  });

});
