import { useEffect, useState } from 'react';
import { watchToolbarPin, type ToolbarPin } from './toolbar-action';

/**
 * The toolbar button's pin state, kept live while the page is open. Starts as
 * `unknown`, which callers treat like "not pinned yet", so a browser that
 * cannot report it still sees how to pin.
 */
export function useToolbarPin(): ToolbarPin {
  const [pin, setPin] = useState<ToolbarPin>('unknown');
  useEffect(() => watchToolbarPin(setPin), []);
  return pin;
}
