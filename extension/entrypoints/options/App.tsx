import { Sparkles } from 'lucide-react';
import AppHeader from '@/components/shared/AppHeader';
import LanguageSwitcher from '@/components/shared/LanguageSwitcher';
import { Button } from '@/components/ui/button';
import { navigateInPlace } from '@/lib/runtime/page-navigation';
import { useExtensionPageRegistration } from '@/lib/runtime/use-extension-page-registration';
import { t } from '@/lib/shared/i18n';

const sectionClass =
  'flex flex-col gap-4 rounded-md border-2 border-border bg-card p-5 sm:flex-row sm:items-center sm:justify-between';

/**
 * The extension's options page: preferences that are set once and rarely
 * revisited live here rather than in the working surfaces. Reachable from the
 * shared header's settings button on every page, the toolbar icon's context
 * menu, and the extension's details page.
 */
export default function App() {
  // Claims this tab as the settings page, so the background stops treating it
  // as whatever page it showed before.
  useExtensionPageRegistration();

  return (
    <div className="min-h-screen bg-background text-foreground">
      <AppHeader current={t().settings.title} currentHeading={{}} isSettingsPage />

      <main className="mx-auto flex max-w-3xl flex-col gap-4 px-6 py-8 sm:px-10">
        <section aria-labelledby="settings-language" className={sectionClass}>
          <div className="flex min-w-0 flex-col gap-1">
            <h2 id="settings-language" className="text-base font-bold">{t().language.label}</h2>
            <p className="text-sm leading-relaxed text-muted-foreground">{t().settings.languageDescription}</p>
          </div>
          <LanguageSwitcher className="h-10 w-full shrink-0 data-[size=default]:h-10 sm:w-56" />
        </section>

        <section aria-labelledby="settings-welcome" className={sectionClass}>
          <div className="flex min-w-0 flex-col gap-1">
            <h2 id="settings-welcome" className="text-base font-bold">{t().settings.welcomeTitle}</h2>
            <p className="text-sm leading-relaxed text-muted-foreground">{t().settings.welcomeDescription}</p>
          </div>
          <Button variant="outline" className="w-full shrink-0 sm:w-56" onClick={() => navigateInPlace('welcome')}>
            <Sparkles />{t().settings.openWelcome}
          </Button>
        </section>
      </main>
    </div>
  );
}
