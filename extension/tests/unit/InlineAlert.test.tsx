// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import InlineAlert from '@/components/shared/InlineAlert';

afterEach(cleanup);

describe('InlineAlert', () => {
  it('announces its message through role="alert"', () => {
    render(<InlineAlert>找不到可錄製的分頁。</InlineAlert>);

    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain('找不到可錄製的分頁。');
    expect(alert.className).toContain('bg-destructive/10');
  });

  it('appends caller spacing classes after the shared block styles', () => {
    render(<InlineAlert className="mt-3">錯誤</InlineAlert>);

    expect(screen.getByRole('alert').className).toContain('mt-3');
  });
});
