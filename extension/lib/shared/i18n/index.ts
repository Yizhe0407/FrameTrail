import { en } from './messages/en';
import { zhTW, type Messages } from './messages/zh-TW';
import { detectBrowserLanguage, documentLanguage, resolveLocale, type Locale } from './locale';

export type { Messages } from './messages/zh-TW';
export { SUPPORTED_LOCALES, resolveLocale, type Locale } from './locale';

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

/** Overrides the browser-derived locale (tests, or a future in-app switch). */
export function setLocale(locale: Locale): void {
  activeLocale = locale;
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
