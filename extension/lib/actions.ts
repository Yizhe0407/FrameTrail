import { browser } from 'wxt/browser';
import type { ResetGuideResult } from './messages';

/** Requests an atomic, Guide-targeted reset from the background lifecycle. */
export async function resetSession(sessionId: string): Promise<void> {
  if (!sessionId) throw new Error('找不到要重置的教學。');
  const result = (await browser.runtime.sendMessage({
    type: 'RESET_GUIDE',
    sessionId,
  })) as ResetGuideResult;
  if (!result.ok) throw new Error(result.error);
}
