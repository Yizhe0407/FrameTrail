/** User-facing copy shared across extension surfaces. Each string lives here
 * exactly once so the background and its UI callers cannot drift apart. */

export const EDITOR_OPEN_FAILED_MESSAGE = '無法開啟編輯器，請再試一次。';

export const LIBRARY_OPEN_FAILED_MESSAGE = '無法開啟作品庫，請再試一次。';

/** Shown when saving descriptions fails for a reason the user can only retry:
 * the editor's own banner uses it, and so does the reply that refuses to let
 * the background navigate this tab to another Guide. */
export const DESCRIPTION_SAVE_RETRY_MESSAGE = '尚有說明無法儲存。請重試後再繼續。';
