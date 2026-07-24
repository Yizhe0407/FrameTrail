// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';
import { copyRichText, downloadBlob } from '@/lib/export/download-utils';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
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

  it('writes HTML and plain text in the same ClipboardItem', async () => {
    const clipboardWrite = vi.fn().mockResolvedValue(undefined);
    class ClipboardItemMock {
      readonly types: Record<string, Blob>;
      constructor(types: Record<string, Blob>) {
        this.types = types;
      }
    }
    vi.stubGlobal('ClipboardItem', ClipboardItemMock);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { write: clipboardWrite },
    });

    await copyRichText('<main>完整教學</main>', '# 完整教學');

    expect(clipboardWrite).toHaveBeenCalledOnce();
    const [items] = clipboardWrite.mock.calls[0] as [[ClipboardItemMock]];
    expect(items).toHaveLength(1);
    expect(Object.keys(items[0].types).sort()).toEqual(['text/html', 'text/plain']);
    expect(items[0].types['text/html'].type).toBe('text/html;charset=utf-8');
    expect(items[0].types['text/plain'].type).toBe('text/plain;charset=utf-8');
  });

});
