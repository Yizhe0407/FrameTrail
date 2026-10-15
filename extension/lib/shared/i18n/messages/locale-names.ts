import type { Locale } from '../locale';

/** Each language named in itself, so a reader can find their own language in
 * the switcher whichever language the UI is currently showing. */
export const LOCALE_NAMES: Record<Locale, string> = {
  'zh-TW': '繁體中文',
  en: 'English',
};
