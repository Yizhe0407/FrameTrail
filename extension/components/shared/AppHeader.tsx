import type { ReactNode } from 'react';
import { ChevronRight, Settings } from 'lucide-react';
import Mascot from './Mascot';
import { reportError } from './report-error';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { openLibrary, openSettings } from '@/lib/runtime/actions';
import { t } from '@/lib/shared/i18n';
import { cn } from '@/lib/shared/utils';

interface Props {
  /**
   * This page's crumb after FrameTrail. Omitted on the library, which is the
   * extension's home: there the brand itself is the current location.
   */
  current?: string;
  /**
   * Render the current crumb as the page's <h1>. `id` lets the page move focus
   * to it (the editor does after opening a requested step).
   */
  currentHeading?: { id?: string };
  /** Live status shown right after the crumbs (e.g. a recording badge). */
  status?: ReactNode;
  /** The page's own actions; the settings button always comes last. */
  actions?: ReactNode;
  /** On the settings page the gear marks the location instead of navigating. */
  isSettingsPage?: boolean;
  /** Navigation failures surface in the page's own alert, like every other error. */
  onNavigationError: (message: string) => void;
}

const crumbClass = 'flex min-w-0 items-center gap-2 rounded-sm px-1.5 py-1 text-base font-bold';

/**
 * The one header every full-page surface shares. It answers "where am I" with
 * a breadcrumb rooted at the library (FrameTrail › page) and keeps settings in
 * the same corner everywhere, so any page reaches any other in one step.
 */
export default function AppHeader({ current, currentHeading, status, actions, isSettingsPage = false, onNavigationError }: Props) {
  const isHome = current === undefined;

  async function navigate(open: () => Promise<void>, failure: string): Promise<void> {
    try {
      await open();
    } catch (error) {
      onNavigationError(reportError('[frametrail] failed to navigate', error, failure));
    }
  }

  const brand = (
    <>
      <Mascot />
      <span className="shrink-0">FrameTrail</span>
    </>
  );

  return (
    <header className="flex h-16 min-h-16 shrink-0 items-center gap-2 border-b-2 border-border bg-card px-4 sm:gap-3 sm:px-8">
      <nav aria-label={t().nav.breadcrumb} className="min-w-0 flex-1">
        <ol className="flex min-w-0 items-center gap-1">
          {/* Pulled left by its own hover padding, so the mascot sits exactly on
              the page gutter that the content below aligns to. */}
          <li className="-ml-1.5 flex shrink-0 items-center">
            {isHome ? (
              <span aria-current="page" className={cn(crumbClass, 'text-foreground')}>{brand}</span>
            ) : (
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    aria-label={t().nav.homeLabel}
                    onClick={() => void navigate(openLibrary, t().nav.libraryOpenFailed)}
                    className={cn(crumbClass, 'text-foreground outline-none transition-colors focus-ring hover:bg-secondary')}
                  >
                    {brand}
                  </button>
                </TooltipTrigger>
                <TooltipContent>{t().nav.homeTooltip}</TooltipContent>
              </Tooltip>
            )}
          </li>
          {!isHome && (
            <li aria-current="page" className="flex min-w-0 items-center gap-1">
              <ChevronRight className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
              {currentHeading ? (
                <h1 id={currentHeading.id} tabIndex={currentHeading.id ? -1 : undefined} className={cn(crumbClass, 'block min-w-0 truncate text-foreground outline-none focus-ring')}>
                  {current}
                </h1>
              ) : (
                <span className={cn(crumbClass, 'block min-w-0 truncate text-foreground')}>{current}</span>
              )}
            </li>
          )}
          {status && <li className="ml-1 flex min-w-0 items-center">{status}</li>}
        </ol>
      </nav>
      <div className="flex shrink-0 items-center gap-1.5 sm:gap-2">
        {actions && (
          <>
            {actions}
            <span className="hidden h-6 w-0.5 rounded-full bg-border-soft sm:block" aria-hidden="true" />
          </>
        )}
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              aria-label={t().settings.open}
              aria-current={isSettingsPage ? 'page' : undefined}
              onClick={isSettingsPage ? undefined : () => void navigate(openSettings, t().nav.settingsOpenFailed)}
              className={cn(isSettingsPage && 'border-border bg-selected text-on-accent hover:bg-selected hover:text-on-accent')}
            >
              <Settings />
            </Button>
          </TooltipTrigger>
          <TooltipContent>{t().settings.open}</TooltipContent>
        </Tooltip>
      </div>
    </header>
  );
}
