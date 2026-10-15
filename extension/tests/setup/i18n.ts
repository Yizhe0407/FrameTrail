import { setLocale } from '@/lib/shared/i18n';

// The suite asserts the Traditional Chinese copy. Pin both the module state and
// the language the detector reads, so a test that resets the module graph
// re-detects the same locale.
Object.defineProperty(globalThis.navigator, 'language', { configurable: true, value: 'zh-TW' });
setLocale('zh-TW');
