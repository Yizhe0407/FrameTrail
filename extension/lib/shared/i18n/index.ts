import { en } from './messages/en';
import { zhTW, type Messages } from './messages/zh-TW';
import { useSyncExternalStore } from 'react';
import { detectBrowserLanguage, documentLanguage, resolveLocale, type Locale } from './locale';

export type { Messages } from './messages/zh-TW';
export { SUPPORTED_LOCALES, resolveLocale, type Locale } from './locale';
export { LOCALE_NAMES } from './messages/locale-names';

/** What the user picked in the language switcher: a fixed locale, or follow
 * the browser UI language. */
export type LocalePreference = 'auto' | Locale;

const CATALOGS: Record<Locale, Messages> = {
  'zh-TW': zhTW,
  en,
};

let activeLocale: Locale = resolveLocale(detectBrowserLanguage());

/**
 * The active UI copy. Read it at the moment text is rendered or produced —
 * never cache a string in module scope — so every surface follows the active
 * locale, including a locale set after the module loaded.
 */
export function t(): Messages {
  return CATALOGS[activeLocale];
}

/** The copy for an explicit locale, for code that must recognize text produced
 * under any locale (e.g. a stored placeholder title). */
export function messagesFor(locale: Locale): Messages {
  return CATALOGS[locale];
}

export function getLocale(): Locale {
  return activeLocale;
}

const listeners = new Set<() => void>();

/** Switches the active locale and tells every subscriber, so mounted UI
 * re-renders in the new language. */
export function setLocale(locale: Locale): void {
  if (locale === activeLocale) return;
  activeLocale = locale;
  for (const listener of listeners) listener();
}

/** Resolves a stored preference ('auto' follows the browser) and applies it. */
export function applyLocalePreference(preference: LocalePreference): void {
  setLocale(preference === 'auto' ? resolveLocale(detectBrowserLanguage()) : preference);
}

export function onLocaleChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Re-renders the calling component whenever the active locale changes. Used
 * at each React root: copy is read through t() during render, so re-rendering
 * the root is all a language switch needs. */
export function useActiveLocale(): Locale {
  return useSyncExternalStore(onLocaleChange, getLocale, getLocale);
}

/** BCP 47 tag for Intl formatting, sorting and case folding in the active locale. */
export function intlLocale(): string {
  return activeLocale;
}

/** `lang` attribute for documents rendered in the active locale. */
export function documentLang(): string {
  return documentLanguage(activeLocale);
}

/** Points an extension page's <html lang> and <title> at the active locale. */
export function localizeDocument(title: string): void {
  document.documentElement.lang = documentLang();
  document.title = title;
}
