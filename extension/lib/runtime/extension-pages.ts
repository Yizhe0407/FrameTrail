/**
 * The extension's full-tab pages. One table for both halves of navigation:
 * pages moving their own tab (lib/runtime/page-navigation.ts) and the
 * background finding and reusing tabs (lib/recording/background/extension-page-tabs.ts).
 */
export const EXTENSION_PAGE_KINDS = ['editor', 'library', 'options', 'welcome'] as const;

export type ExtensionPageKind = (typeof EXTENSION_PAGE_KINDS)[number];

// `as const` keeps the literal paths, which is what WXT's typed getURL accepts.
export const EXTENSION_PAGE_PATHS = {
  editor: '/editor.html',
  library: '/library.html',
  options: '/options.html',
  welcome: '/welcome.html',
} as const satisfies Record<ExtensionPageKind, string>;
