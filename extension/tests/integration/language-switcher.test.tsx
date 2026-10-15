// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const storage = vi.hoisted(() => {
  const values: Record<string, unknown> = {};
  const listeners = new Set<(changes: Record<string, { newValue?: unknown }>, area: string) => void>();
  return {
    values,
    listeners,
    get: vi.fn(async (key: string) => (key in values ? { [key]: values[key] } : {})),
    set: vi.fn(async (items: Record<string, unknown>) => {
      Object.assign(values, items);
      const changes = Object.fromEntries(Object.entries(items).map(([key, value]) => [key, { newValue: value }]));
      for (const listener of listeners) listener(changes, 'local');
    }),
  };
});

vi.mock('wxt/browser', () => ({
  browser: {
    storage: {
      local: { get: storage.get, set: storage.set },
      onChanged: {
        addListener: (listener: never) => storage.listeners.add(listener),
        removeListener: (listener: never) => storage.listeners.delete(listener),
      },
    },
  },
}));

import LanguageSwitcher from '@/components/shared/LanguageSwitcher';
import { initLocalePreference } from '@/lib/runtime/locale-preference';
import { getLocale, setLocale, t, useActiveLocale } from '@/lib/shared/i18n';

function Page() {
  useActiveLocale();
  return (
    <>
      <LanguageSwitcher />
      <p>{t().common.startRecording}</p>
    </>
  );
}

beforeEach(() => {
  for (const key of Object.keys(storage.values)) delete storage.values[key];
  storage.listeners.clear();
  setLocale('zh-TW');
});

afterEach(() => {
  cleanup();
  setLocale('zh-TW');
});

describe('language switcher', () => {
  it('re-renders the page in the chosen language and stores the choice', async () => {
    render(<Page />);
    expect(screen.getByText('開始錄製')).toBeTruthy();

    fireEvent.change(screen.getByRole('combobox', { name: '語言' }), { target: { value: 'en' } });

    await waitFor(() => expect(screen.getByText('Start recording')).toBeTruthy());
    expect(screen.getByRole('combobox', { name: 'Language' })).toBeTruthy();
    expect(storage.values['frametrail:localePreference']).toBe('en');
  });

  it('follows the browser again when switched back to automatic', async () => {
    render(<Page />);
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'en' } });
    await waitFor(() => expect(getLocale()).toBe('en'));

    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'auto' } });
    // The suite pins the browser language to zh-TW.
    await waitFor(() => expect(screen.getByText('開始錄製')).toBeTruthy());
  });
});

describe('initLocalePreference', () => {
  it('applies the stored choice and follows changes made in other contexts', async () => {
    storage.values['frametrail:localePreference'] = 'en';
    const stop = await initLocalePreference();
    expect(getLocale()).toBe('en');

    await storage.set({ 'frametrail:localePreference': 'zh-TW' });
    expect(getLocale()).toBe('zh-TW');

    stop();
    await storage.set({ 'frametrail:localePreference': 'en' });
    expect(getLocale()).toBe('zh-TW');
  });

  it('ignores an unknown stored value', async () => {
    storage.values['frametrail:localePreference'] = 'klingon';
    await initLocalePreference();
    expect(getLocale()).toBe('zh-TW');
  });
});
