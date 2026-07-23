// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  updateTab: vi.fn(),
  updateWindow: vi.fn(),
  openPopup: vi.fn(),
}));

vi.mock('wxt/browser', () => ({
  browser: {
    tabs: { query: mocks.query, update: mocks.updateTab },
    windows: { update: mocks.updateWindow },
    action: { openPopup: mocks.openPopup },
  },
}));

import EmptyState from '@/components/shared/EmptyState';

beforeEach(() => {
  mocks.query.mockReset();
  mocks.updateTab.mockReset();
  mocks.updateWindow.mockReset();
  mocks.openPopup.mockReset();
  mocks.updateTab.mockResolvedValue({ id: 2, windowId: 7 });
  mocks.updateWindow.mockResolvedValue(undefined);
  mocks.openPopup.mockResolvedValue(undefined);
});

afterEach(cleanup);

describe('editor empty state', () => {
  it('returns to the most recently used web tab and opens recording setup', async () => {
    mocks.query.mockResolvedValue([
      { id: 1, url: 'chrome-extension://frame/editor.html', lastAccessed: 30 },
      { id: 2, url: 'https://example.com/older', lastAccessed: 10 },
      { id: 3, url: 'https://example.com/recent', lastAccessed: 20 },
    ]);

    render(<EmptyState />);
    fireEvent.click(screen.getByRole('button', { name: '回到網頁開始錄製' }));

    await waitFor(() => expect(mocks.openPopup).toHaveBeenCalledOnce());
    expect(mocks.updateTab).toHaveBeenCalledWith(3, { active: true });
    expect(mocks.updateWindow).toHaveBeenCalledWith(7, { focused: true });
  });

  it('focuses the active recording tab without opening another setup popup', async () => {
    mocks.query.mockResolvedValue([
      { id: 2, url: 'https://example.com', lastAccessed: 10 },
      { id: 5, url: 'https://recording.example.com', lastAccessed: 1 },
    ]);
    mocks.updateTab.mockResolvedValue({ id: 5, windowId: 8 });

    render(<EmptyState isRecording recordingTabId={5} />);
    fireEvent.click(screen.getByRole('button', { name: '回到錄製分頁' }));

    await waitFor(() => expect(mocks.updateWindow).toHaveBeenCalledWith(8, { focused: true }));
    expect(mocks.updateTab).toHaveBeenCalledWith(5, { active: true });
    expect(mocks.openPopup).not.toHaveBeenCalled();
  });
});
