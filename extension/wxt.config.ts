import { defineConfig } from 'wxt';
import tailwindcss from '@tailwindcss/vite';

// See https://wxt.dev/api/config.html
export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  vite: () => ({
    plugins: [tailwindcss()],
  }),
  manifest: {
    name: 'FrameTrail',
    description: 'Record clicks and auto-generate a step-by-step annotated image guide',
    permissions: ['storage', 'unlimitedStorage', 'activeTab', 'scripting', 'downloads', 'clipboardWrite'],
    optional_host_permissions: ['<all_urls>'],
    // No default keys: users bind them at chrome://extensions/shortcuts so we
    // never hijack a site's own hotkeys (UX_PLAN §8.3).
    commands: {
      'toggle-pause': { description: '錄製：暫停或繼續' },
      'undo-last-capture': { description: '錄製：復原上一個' },
      'finish-recording': { description: '錄製：完成' },
    },
    web_accessible_resources: [
      {
        resources: ['snapshot-shield.html'],
        matches: ['<all_urls>'],
      },
    ],
    browser_specific_settings: {
      gecko: {
        id: 'frametrail@local',
        data_collection_permissions: {
          required: ['none'],
        },
      },
    },
  },
  hooks: {
    // Runtime content scripts make WXT infer a required host permission. The
    // recorder only needs it after an explicit Start action, so keep it optional.
    'build:manifestGenerated': (_, manifest) => {
      manifest.host_permissions = manifest.host_permissions?.filter((permission: string) => permission !== '<all_urls>');
      if (manifest.host_permissions?.length === 0) delete manifest.host_permissions;
      if (manifest.manifest_version === 2) {
        manifest.optional_permissions ??= [];
        if (!manifest.optional_permissions.includes('<all_urls>')) manifest.optional_permissions.push('<all_urls>');
      }
    },
  },
});
