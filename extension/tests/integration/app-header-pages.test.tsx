// @vitest-environment jsdom
import { cleanup, fireEvent, render as rtlRender, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';

function render(ui: Parameters<typeof rtlRender>[0]) {
  return rtlRender(ui, { wrapper: TooltipProvider });
}

const mocks = vi.hoisted(() => ({ navigateInPlace: vi.fn(), registerPage: vi.fn() }));

vi.mock('@/lib/runtime/page-navigation', () => ({ navigateInPlace: mocks.navigateInPlace }));
vi.mock('@/lib/runtime/use-extension-page-registration', () => ({ useExtensionPageRegistration: mocks.registerPage }));
vi.mock('@/lib/runtime/locale-preference', () => ({
  getLocalePreference: vi.fn().mockResolvedValue('auto'),
  setLocalePreference: vi.fn(),
}));

import OptionsApp from '@/entrypoints/options/App';
import WelcomeApp from '@/entrypoints/welcome/App';

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(cleanup);

function breadcrumb() {
  return within(screen.getByRole('navigation', { name: '目前位置' }));
}

describe('welcome page', () => {
  it('sits under Stepmark in the shared header and turns into the library', () => {
    render(<WelcomeApp />);

    expect(mocks.registerPage).toHaveBeenCalled();
    expect(breadcrumb().getByText('歡迎').closest('li')?.getAttribute('aria-current')).toBe('page');
    expect(screen.getByRole('heading', { level: 1, name: '嗨！我是 Stepmark' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /前往作品庫/ }));
    expect(mocks.navigateInPlace).toHaveBeenCalledWith('library');
  });

  it('covers pinning, both recording modes and the up-front limits', () => {
    render(<WelcomeApp />);

    expect(screen.getByRole('heading', { level: 2, name: /先把我釘到工具列/ })).toBeTruthy();
    expect(screen.getByRole('img', { name: /擴充功能選單/ })).toBeTruthy();
    expect(screen.getByText('每次點擊都會擷取一張截圖，自動編號成一連串操作步驟。')).toBeTruthy();
    expect(screen.getByText('鎖定目前畫面，在同一張截圖上加入多個標註點。')).toBeTruthy();
    expect(screen.getByText('所有截圖都只存在這台電腦，不會上傳。')).toBeTruthy();
  });
});

describe('settings page', () => {
  it('marks the gear as the current location instead of a link to itself', () => {
    render(<OptionsApp />);

    expect(breadcrumb().getByRole('heading', { level: 1, name: '設定' })).toBeTruthy();
    const gear = screen.getByRole('button', { name: '設定' });
    expect(gear.getAttribute('aria-current')).toBe('page');
    fireEvent.click(gear);
    expect(mocks.navigateInPlace).not.toHaveBeenCalled();
  });

  it('returns to the library in the same tab from the Stepmark crumb', async () => {
    render(<OptionsApp />);

    expect(mocks.registerPage).toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Stepmark 作品庫' }));

    await waitFor(() => expect(mocks.navigateInPlace).toHaveBeenCalledWith('library'));
  });

  it('turns into the welcome page on request', () => {
    render(<OptionsApp />);

    fireEvent.click(screen.getByRole('button', { name: /打開歡迎頁/ }));

    expect(mocks.navigateInPlace).toHaveBeenCalledWith('welcome');
  });
});
