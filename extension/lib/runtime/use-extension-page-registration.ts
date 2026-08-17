import { useEffect } from 'react';
import { browser } from 'wxt/browser';

/**
 * Announces this extension page's tab to the background, so every later "open
 * the editor / open the library" request reuses it instead of spawning another
 * tab. lib/recording/background/extension-page-tabs.ts explains why the
 * background cannot discover its own pages without this.
 *
 * Re-announced whenever the window regains focus: if several copies of a page
 * are somehow open, the one the user last looked at is the one that gets
 * reused.
 */
export function useExtensionPageRegistration(): void {
  useEffect(() => {
    const register = () => {
      void (async () => {
        try {
          await browser.runtime.sendMessage({ type: 'REGISTER_EXTENSION_PAGE' });
        } catch (error) {
          // Non-fatal: the page still works, later opens just cannot reuse it.
          console.warn('[frametrail] failed to register this extension page tab', error);
        }
      })();
    };
    register();
    window.addEventListener('focus', register);
    return () => window.removeEventListener('focus', register);
  }, []);
}
