import { vi } from 'vitest';

/**
 * (Re)imports the background entrypoint so each test starts a fresh
 * service-worker instance against the mocks configured in the calling file.
 */
export async function importBackground(): Promise<void> {
  vi.resetModules();
  vi.stubGlobal('defineBackground', (setup: () => unknown) => setup());
  await import('@/entrypoints/background');
}

/** Drains chained microtask work (mocked async storage/tabs round trips). */
export async function flushAsyncWork(rounds = 40): Promise<void> {
  for (let i = 0; i < rounds; i++) await Promise.resolve();
}
