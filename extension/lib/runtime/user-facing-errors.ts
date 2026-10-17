import { t } from '@/lib/shared/i18n';
import { describeBrowserError, isErrorPageError } from './browser-errors';

/**
 * An error whose message is already localized copy meant for the user (e.g.
 * "Step skipped: …"). Throw this instead of a plain Error when the message is
 * expected to surface in state.error, so it is shown verbatim — never as the
 * diagnostic "Error: …" rendering describeBrowserError produces for logs.
 */
export class UserFacingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UserFacingError';
  }
}

/** Raw extension-API failures the user can act on, mapped to localized copy.
 * Matched on the browser's English diagnostic text, which is not localized. */
const KNOWN_BROWSER_ERRORS: ReadonlyArray<{ pattern: RegExp; message: () => string }> = [
  {
    pattern: /'<all_urls>' or 'activeTab' permission is required|cannot access contents of|missing host permission/i,
    message: () => t().background.errorSiteAccessLost,
  },
  {
    pattern: /MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND/,
    message: () => t().background.errorCaptureTooFast,
  },
  {
    pattern: /tabs cannot be edited right now|user may be dragging a tab/i,
    message: () => t().background.errorBrowserBusy,
  },
];

/**
 * The text to show the user for a failure: localized copy carried by a
 * UserFacingError as-is, a known browser API failure translated, and anything
 * else (an unexpected internal or browser error) replaced by the caller's
 * localized fallback. Raw diagnostics belong in the console, not in the UI.
 */
export function userFacingErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof UserFacingError) return error.message;
  if (isErrorPageError(error)) return t().background.errorPageFailedToLoad;
  const diagnostic = describeBrowserError(error, '');
  if (diagnostic) {
    for (const known of KNOWN_BROWSER_ERRORS) {
      if (known.pattern.test(diagnostic)) return known.message();
    }
  }
  return fallback;
}
