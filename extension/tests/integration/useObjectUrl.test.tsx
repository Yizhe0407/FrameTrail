// @vitest-environment jsdom
import { render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useObjectUrl } from '@/lib/useObjectUrl';

function Consumer({ blob }: { blob: Blob }) {
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
});
