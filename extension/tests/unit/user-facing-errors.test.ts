import { describe, expect, it } from 'vitest';
import { zhTW } from '@/lib/shared/i18n/messages/zh-TW';
import { UserFacingError, userFacingErrorMessage } from '@/lib/runtime/user-facing-errors';

const FALLBACK = 'fallback copy';

describe('userFacingErrorMessage', () => {
  it('shows localized copy carried by a UserFacingError verbatim, without an "Error: " prefix', () => {
    expect(userFacingErrorMessage(new UserFacingError(zhTW.background.stepSkippedPageChanged), FALLBACK))
      .toBe(zhTW.background.stepSkippedPageChanged);
  });

  it.each([
    ["Either the '<all_urls>' or 'activeTab' permission is required.", zhTW.background.errorSiteAccessLost],
    ['Cannot access contents of the page. Extension manifest must request permission to access the respective host.', zhTW.background.errorSiteAccessLost],
    ['Missing host permission for the tab', zhTW.background.errorSiteAccessLost],
    ['This request exceeds the MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND quota.', zhTW.background.errorCaptureTooFast],
    ['Tabs cannot be edited right now (user may be dragging a tab).', zhTW.background.errorBrowserBusy],
    ['Frame with ID 0 is showing error page', zhTW.background.errorPageFailedToLoad],
  ])('translates the browser error %j', (raw, expected) => {
    expect(userFacingErrorMessage(new Error(raw), FALLBACK)).toBe(expected);
  });

  it('never shows an unknown internal or browser diagnostic', () => {
    expect(userFacingErrorMessage(new Error('Snapshot capture context is incomplete.'), FALLBACK)).toBe(FALLBACK);
    expect(userFacingErrorMessage(new DOMException('', 'AbortError'), FALLBACK)).toBe(FALLBACK);
    expect(userFacingErrorMessage(undefined, FALLBACK)).toBe(FALLBACK);
  });
});
