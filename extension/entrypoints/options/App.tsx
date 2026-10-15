import Mascot from '@/components/shared/Mascot';
import LanguageSwitcher from '@/components/shared/LanguageSwitcher';
import { t } from '@/lib/shared/i18n';

/**
 * The extension's options page: preferences that are set once and rarely
 * revisited live here rather than in the working surfaces. Reachable from the
 * popup and library settings buttons, the toolbar icon's context menu, and
 * the extension's details page.
 */
export default function App() {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="border-b-2 border-border bg-card">
        <div className="mx-auto flex max-w-3xl items-center gap-3 px-6 py-5 sm:px-10">
          <Mascot className="size-11" />
          <div className="flex flex-col">
            <span className="text-xs font-bold text-muted-foreground">FrameTrail</span>
            <h1 className="text-2xl leading-tight font-bold">{t().settings.title}</h1>
          </div>
        </div>
      </header>

      <main className="mx-auto flex max-w-3xl flex-col gap-4 px-6 py-8 sm:px-10">
        <section
          aria-labelledby="settings-language"
          className="flex flex-col gap-4 rounded-md border-2 border-border bg-card p-5 sm:flex-row sm:items-center sm:justify-between"
        >
          <div className="flex min-w-0 flex-col gap-1">
            <h2 id="settings-language" className="text-base font-bold">{t().language.label}</h2>
            <p className="text-sm leading-relaxed text-muted-foreground">{t().settings.languageDescription}</p>
          </div>
          <LanguageSwitcher className="h-10 w-full data-[size=default]:h-10 sm:w-56" />
        </section>
      </main>
    </div>
  );
}
