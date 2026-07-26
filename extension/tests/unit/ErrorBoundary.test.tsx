// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import ErrorBoundary from '@/components/shared/ErrorBoundary';

function Boom(): never {
  throw new Error('render exploded');
}

/** React logs caught render errors to console.error; keep suite output clean. */
function withSilencedErrorLog(run: () => void): void {
  const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    run();
  } finally {
    consoleError.mockRestore();
  }
}

afterEach(cleanup);

describe('ErrorBoundary', () => {
  it('renders children untouched when nothing throws', () => {
    render(
      <ErrorBoundary label="編輯器">
        <p>正常內容</p>
      </ErrorBoundary>,
    );

    expect(screen.getByText('正常內容')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('renders the labelled fallback with a reload action when a child throws', () => {
    withSilencedErrorLog(() => {
      render(
        <ErrorBoundary label="編輯器">
          <Boom />
        </ErrorBoundary>,
      );
    });

    expect(screen.getByRole('alert')).toBeTruthy();
    expect(screen.getByText('編輯器發生錯誤')).toBeTruthy();
    expect(screen.getByText('render exploded')).toBeTruthy();

    const originalLocation = Object.getOwnPropertyDescriptor(window, 'location');
    const reload = vi.fn();
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { ...window.location, reload },
    });
    try {
      fireEvent.click(screen.getByRole('button', { name: '重新載入' }));
      expect(reload).toHaveBeenCalledOnce();
    } finally {
      if (originalLocation) Object.defineProperty(window, 'location', originalLocation);
    }
  });

  it('clears the fallback and notifies onReset when retry is available', () => {
    let broken = true;
    const onReset = vi.fn(() => {
      broken = false;
    });

    function Flaky() {
      if (broken) throw new Error('暫時性錯誤');
      return <p>已復原</p>;
    }

    withSilencedErrorLog(() => {
      render(
        <ErrorBoundary label="作品庫" onReset={onReset}>
          <Flaky />
        </ErrorBoundary>,
      );
    });

    fireEvent.click(screen.getByRole('button', { name: '重試' }));

    expect(onReset).toHaveBeenCalledOnce();
    expect(screen.getByText('已復原')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
