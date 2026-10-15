import { browser } from 'wxt/browser';
import { EXTENSION_PAGE_PATHS } from './extension-pages';

/** Pages a page may simply turn into. The editor is not one of them. */
export type InPlacePage = 'library' | 'options' | 'welcome';

/**
 * Moves this page's own tab to another extension page: navigating between
 * the extension's pages never spawns a tab. Opening the editor goes through
 * openSelectedProjectInEditor instead, because the single editor tab — wherever
 * it already is — takes precedence over replacing this one.
 */
export function navigateInPlace(page: InPlacePage): void {
  window.location.assign(browser.runtime.getURL(EXTENSION_PAGE_PATHS[page]));
}
