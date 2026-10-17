// @vitest-environment jsdom
import { render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useObjectUrl } from '@/lib/editor/use-object-url';

function Consumer({ blob }: { blob: Blob | null }) {
  return <span>{useObjectUrl(blob)}</span>;
}

function Fixture({ blob, second }: { blob: Blob; second: boolean }) {
  return (
    <>
      <Consumer blob={blob} />
      {second && <Consumer blob={blob} />}
    </>
  );
}

afterEach(() => vi.restoreAllMocks());

describe('useObjectUrl', () => {
  it('shares one URL and releases it after the final consumer unmounts', () => {
    const create = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:shared');
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    const blob = new Blob(['image']);
    const view = render(<Fixture blob={blob} second />);

    expect(view.getAllByText('blob:shared')).toHaveLength(2);
    expect(create).toHaveBeenCalledOnce();

    view.rerender(<Fixture blob={blob} second={false} />);
    expect(revoke).not.toHaveBeenCalled();

    view.unmount();
    expect(revoke).toHaveBeenCalledExactlyOnceWith('blob:shared');
  });

  it("has no URL for no Blob, and never returns one Blob's URL for another", () => {
    const create = vi.spyOn(URL, 'createObjectURL').mockImplementation((blob) => `blob:${(blob as Blob).size}`);
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    const seen: string[] = [];
    function Recorder({ blob }: { blob: Blob | null }) {
      const url = useObjectUrl(blob);
      seen.push(url);
      return null;
    }
    const first = new Blob(['a']);
    const view = render(<Recorder blob={null} />);
    expect(create).not.toHaveBeenCalled();
    view.rerender(<Recorder blob={first} />);
    expect(seen.at(-1)).toBe('blob:1');
    seen.length = 0;
    view.rerender(<Recorder blob={new Blob(['bb'])} />);
    expect(seen).not.toContain('blob:1');
    expect(seen.at(-1)).toBe('blob:2');
    view.rerender(<Recorder blob={null} />);
    expect(seen.at(-1)).toBe('');
  });
});
