// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  copyRichText,
  downloadBlob,
  loadHtmlIntoWindow,
  openPrintPlaceholder,
} from '@/lib/download-utils';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('download utilities', () => {
  it('downloads through a temporary anchor and always revokes the object URL', async () => {
    const createObjectURL = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:guide');
    const revokeObjectURL = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});

    await downloadBlob(new Blob(['guide']), 'guide.md');

    expect(createObjectURL).toHaveBeenCalledOnce();
    expect(click).toHaveBeenCalledOnce();
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:guide');
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

  it('opens about:blank synchronously for the print flow', () => {
    const placeholder = {} as Window;
    const open = vi.spyOn(window, 'open').mockReturnValue(placeholder);

    expect(openPrintPlaceholder()).toBe(placeholder);
    expect(open).toHaveBeenCalledWith('about:blank', '_blank');
  });

  it('loads print HTML by Blob navigation without document markup injection and revokes after load', async () => {
    const createObjectURL = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:print-guide');
    const revokeObjectURL = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    const eventTarget = new EventTarget();
    const location = {
      href: 'about:blank',
      replace: vi.fn((url: string) => {
        location.href = url;
        queueMicrotask(() => eventTarget.dispatchEvent(new Event('load')));
      }),
    };
    const targetWindow = Object.assign(eventTarget, { location }) as unknown as Window;

    await loadHtmlIntoWindow(targetWindow, '<!doctype html><title>列印</title>');

    expect(createObjectURL).toHaveBeenCalledOnce();
    expect(location.replace).toHaveBeenCalledWith('blob:print-guide');
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:print-guide');
  });

  it('revokes the print URL when generation flow is cancelled during navigation', async () => {
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:print-guide');
    const revokeObjectURL = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    const eventTarget = new EventTarget();
    const location = { href: 'about:blank', replace: vi.fn() };
    const targetWindow = Object.assign(eventTarget, { location }) as unknown as Window;
    const controller = new AbortController();

    const loading = loadHtmlIntoWindow(targetWindow, '<!doctype html>', controller.signal);
    controller.abort();

    await expect(loading).rejects.toMatchObject({ name: 'AbortError' });
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:print-guide');
  });
});
