import { onTestFinished, vi } from 'vitest';

/**
 * Silences console.error/console.warn for the current test only, restoring the
 * real console when the test finishes. Reserved for tests that intentionally
 * drive failure paths whose defensive logging would otherwise pollute the run
 * output — never install it file-wide from a hook, so an unexpected error in a
 * happy-path test still surfaces.
 */
export function silenceIntentionalErrorLogs(): void {
  const spies = [
    vi.spyOn(console, 'error').mockImplementation(() => {}),
    vi.spyOn(console, 'warn').mockImplementation(() => {}),
  ];
  onTestFinished(() => {
    for (const spy of spies) spy.mockRestore();
  });
}
