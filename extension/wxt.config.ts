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
    permissions: ['storage', 'unlimitedStorage', 'activeTab', 'scripting', 'downloads'],
  },
});
