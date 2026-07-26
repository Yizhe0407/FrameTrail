import { cleanup } from '@testing-library/react';
import { vi } from 'vitest';

/**
 * Shared jsdom scaffolding for the StepRail suites: the rail reads
 * ResizeObserver / matchMedia / scrollIntoView and creates object URLs, none
 * of which exist in jsdom. Call in beforeEach and pair with
 * removeStepRailDomStubs in afterEach.
 */
export function installStepRailDomStubs(): void {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
      unobserve() {}
    },
  );
  vi.stubGlobal('matchMedia', () => ({
    matches: true,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:step-rail');
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() });
}

/** Mirror teardown for installStepRailDomStubs. */
export function removeStepRailDomStubs(): void {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  delete (HTMLElement.prototype as { scrollIntoView?: unknown }).scrollIntoView;
}
