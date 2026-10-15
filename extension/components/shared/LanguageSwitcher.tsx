import { useEffect, useState } from 'react';
import { Languages } from 'lucide-react';
import { getLocalePreference, setLocalePreference } from '@/lib/runtime/locale-preference';
import { LOCALE_NAMES, SUPPORTED_LOCALES, t, type LocalePreference } from '@/lib/shared/i18n';
import { cn } from '@/lib/shared/utils';

interface Props {
  className?: string;
}

/**
 * The extension-wide language choice. The preference is stored once and every
 * surface — this page, other open pages, the background worker and the in-page
 * recording toolbar — switches as soon as it changes, without a reload.
 */
export default function LanguageSwitcher({ className }: Props) {
  const [preference, setPreference] = useState<LocalePreference>('auto');

  useEffect(() => {
    let active = true;
    void getLocalePreference()
      .then((stored) => {
        if (active) setPreference(stored);
      })
      .catch((error) => console.warn('[frametrail] failed to read the language preference', error));
    return () => {
      active = false;
    };
  }, []);

  async function choose(next: LocalePreference) {
    const previous = preference;
    setPreference(next);
    try {
      await setLocalePreference(next);
    } catch (error) {
      console.error('[frametrail] failed to save the language preference', error);
      setPreference(previous);
    }
  }

  return (
    <label
      className={cn(
        'relative flex h-8 shrink-0 items-center gap-1.5 rounded-md border-2 border-border bg-card pr-2 pl-2.5 text-xs font-bold text-foreground focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-focus',
        className,
      )}
    >
      <Languages className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
      <span className="sr-only">{t().language.label}</span>
      <select
        value={preference}
        onChange={(event) => void choose(event.target.value as LocalePreference)}
        className="min-w-0 flex-1 cursor-pointer appearance-none bg-transparent pr-4 outline-none"
      >
        <option value="auto">{t().language.auto}</option>
        {SUPPORTED_LOCALES.map((locale) => (
          <option key={locale} value={locale} lang={locale}>{LOCALE_NAMES[locale]}</option>
        ))}
      </select>
      <svg viewBox="0 0 10 6" aria-hidden="true" className="pointer-events-none absolute right-2 h-1.5 w-2.5 fill-current">
        <path d="M0 0h10L5 6z" />
      </svg>
    </label>
  );
}
