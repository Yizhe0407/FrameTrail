// @vitest-environment jsdom
import { cleanup, fireEvent, render as rtlRender, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import { silenceIntentionalErrorLogs } from '../setup/silence-intentional-logs';

function render(ui: Parameters<typeof rtlRender>[0]) {
  return rtlRender(ui, { wrapper: TooltipProvider });
}

const mocks = vi.hoisted(() => ({
  openLibrary: vi.fn(),
  openSettings: vi.fn(),
  openWelcomePage: vi.fn(),
}));

vi.mock('@/lib/runtime/actions', () => ({ openLibrary: mocks.openLibrary, openSettings: mocks.openSettings }));
vi.mock('@/lib/runtime/welcome', () => ({ openWelcomePage: mocks.openWelcomePage }));
vi.mock('@/lib/runtime/locale-preference', () => ({
  getLocalePreference: vi.fn().mockResolvedValue('auto'),
  setLocalePreference: vi.fn(),
}));

import OptionsApp from '@/entrypoints/options/App';
import WelcomeApp from '@/entrypoints/welcome/App';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.openLibrary.mockResolvedValue(undefined);
  mocks.openSettings.mockResolvedValue(undefined);
  mocks.openWelcomePage.mockResolvedValue(undefined);
});

afterEach(cleanup);

function breadcrumb() {
  return within(screen.getByRole('navigation', { name: '目前位置' }));
}

describe('welcome page', () => {
  it('sits under FrameTrail in the shared header and leads to the library', () => {
    render(<WelcomeApp />);

    expect(breadcrumb().getByText('歡迎').closest('li')?.getAttribute('aria-current')).toBe('page');
    expect(screen.getByRole('heading', { level: 1, name: '嗨！我是 FrameTrail' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /前往作品庫/ }));
    expect(mocks.openLibrary).toHaveBeenCalledOnce();
  });

  it('covers pinning, both recording modes and the up-front limits', () => {
    render(<WelcomeApp />);

    expect(screen.getByRole('heading', { level: 2, name: /先把我釘到工具列/ })).toBeTruthy();
    expect(screen.getByRole('img', { name: /擴充功能選單/ })).toBeTruthy();
    expect(screen.getByText('每次點擊都會擷取一張截圖，自動編號成一連串操作步驟。')).toBeTruthy();
    expect(screen.getByText('鎖定目前畫面，在同一張截圖上加入多個標註點。')).toBeTruthy();
    expect(screen.getByText('所有截圖都只存在這台電腦，不會上傳。')).toBeTruthy();
  });

  it('shows a failed jump to the library in the page', async () => {
    silenceIntentionalErrorLogs();
    mocks.openLibrary.mockRejectedValue('worker asleep');
    render(<WelcomeApp />);

    fireEvent.click(screen.getByRole('button', { name: /前往作品庫/ }));

    expect(await screen.findByText('無法開啟作品庫，請再試一次。')).toBeTruthy();
  });
});

describe('settings page', () => {
  it('marks the gear as the current location instead of a link to itself', () => {
    render(<OptionsApp />);

    expect(breadcrumb().getByRole('heading', { level: 1, name: '設定' })).toBeTruthy();
    const gear = screen.getByRole('button', { name: '設定' });
    expect(gear.getAttribute('aria-current')).toBe('page');
    fireEvent.click(gear);
    expect(mocks.openSettings).not.toHaveBeenCalled();
  });

  it('returns to the library from the FrameTrail crumb', () => {
    render(<OptionsApp />);

    fireEvent.click(screen.getByRole('button', { name: 'FrameTrail 作品庫' }));

    expect(mocks.openLibrary).toHaveBeenCalledOnce();
  });

  it('reopens the welcome page on request', async () => {
    render(<OptionsApp />);

    fireEvent.click(screen.getByRole('button', { name: /打開歡迎頁/ }));

    await waitFor(() => expect(mocks.openWelcomePage).toHaveBeenCalledOnce());
  });
});
