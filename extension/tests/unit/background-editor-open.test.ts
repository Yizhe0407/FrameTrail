import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RecordingState } from '@/lib/storage/recording-state';
import { makeRecordingState } from '../setup/recording-state';
import { flushAsyncWork, importBackground } from '../setup/background-test-utils';
import { silenceIntentionalErrorLogs } from '../setup/silence-intentional-logs';

const mocks = await vi.hoisted(async () => (await import('../setup/background-test-utils')).makeBackgroundMocks());

vi.mock('wxt/browser', async () =>
  (await import('../setup/background-test-utils')).mockWxtBrowserModule(mocks));
vi.mock('@/lib/storage/step-repository', async (importOriginal) =>
  (await import('../setup/background-test-utils')).mockStepRepositoryModule(mocks, importOriginal));
vi.mock('@/lib/storage/guide-repository', async (importOriginal) =>
  (await import('../setup/background-test-utils')).mockGuideRepositoryModule(mocks, importOriginal));
vi.mock('@/lib/storage/storage', async (importOriginal) =>
  (await import('../setup/background-test-utils')).mockStorageModule(mocks, importOriginal));
vi.mock('@/lib/recording/background/pending-undo-store', async () =>
  (await import('../setup/background-test-utils')).mockPendingUndoStoreModule(mocks));

const EDITOR_KEY = 'frametrail:extensionPageTab:editor';
const EDITOR_TAB = { tabId: 12, windowId: 4 };
const EXTENSION_PAGE_SENDER = { url: 'chrome-extension://extension-id/popup.html' };
const EDITOR_URL_PREFIX = 'chrome-extension://extension-id/editor.html';

let storedState: RecordingState;

async function openEditor(message: { sessionId?: string; entryId?: string } = {}): Promise<unknown> {
  const result = await mocks.messageListener?.({ type: 'OPEN_EDITOR', ...message }, EXTENSION_PAGE_SENDER);
  await flushAsyncWork();
  return result;
}

/** Puts an editor tab in the registry, as REGISTER_EXTENSION_PAGE would. */
function withRegisteredEditor(): void {
  mocks.sessionGet.mockImplementation(async (keys?: string | string[]) =>
    (keys === EDITOR_KEY || (Array.isArray(keys) && keys.includes(EDITOR_KEY))
      ? { [EDITOR_KEY]: EDITOR_TAB }
      : {}));
}

beforeEach(async () => {
  vi.clearAllMocks();
  mocks.messageListener = null;
  storedState = makeRecordingState({ sessionId: null });
  mocks.getRecordingState.mockImplementation(async () => storedState);
  mocks.setRecordingState.mockImplementation(async (next: RecordingState) => {
    storedState = next;
  });
  // vi.clearAllMocks only clears calls, so restore the implementations this
  // suite deliberately overrides per test.
  mocks.sessionGet.mockResolvedValue({});
  mocks.sessionSet.mockResolvedValue(undefined);
  mocks.sessionRemove.mockResolvedValue(undefined);
  mocks.tabsSendMessage.mockResolvedValue(undefined);
  mocks.getGuide.mockResolvedValue({ id: 'guide-a', title: 'Guide A' });
  mocks.getSteps.mockResolvedValue([]);
  mocks.tabsCreate.mockResolvedValue({ id: 77, windowId: 1 });
  mocks.tabsUpdate.mockResolvedValue(undefined);
  mocks.windowsUpdate.mockResolvedValue(undefined);
  mocks.tabsGet.mockResolvedValue({ id: 12, windowId: 4 });
  mocks.readPendingUndoRecord.mockResolvedValue(null);
  mocks.clearPendingUndoRecord.mockResolvedValue(undefined);
  mocks.savePendingUndoRecord.mockResolvedValue(undefined);
  mocks.executeScript.mockResolvedValue([]);
  await importBackground();
  await flushAsyncWork();
});

describe('the single editor opener', () => {
  it('creates the one editor tab when no page has registered', async () => {
    await expect(openEditor({ sessionId: 'guide-a' })).resolves.toEqual({ ok: true });

    expect(mocks.tabsSendMessage).not.toHaveBeenCalled();
    expect(mocks.tabsCreate).toHaveBeenCalledExactlyOnceWith({
      url: `${EDITOR_URL_PREFIX}?sessionId=guide-a`,
      active: true,
    });
  });

  it('focuses, and never navigates, an editor already showing this Guide', async () => {
    withRegisteredEditor();
    mocks.tabsSendMessage.mockResolvedValue({ ok: true, ready: true });

    await expect(openEditor({ sessionId: 'guide-a', entryId: 'step-3' })).resolves.toEqual({ ok: true });

    expect(mocks.tabsSendMessage).toHaveBeenCalledExactlyOnceWith(12, {
      type: 'EDITOR_HANDOFF',
      sessionId: 'guide-a',
      entryId: 'step-3',
    });
    // The page selected the entry itself, so activation is the whole job.
    expect(mocks.tabsUpdate).toHaveBeenCalledExactlyOnceWith(12, { active: true });
    expect(mocks.windowsUpdate).toHaveBeenCalledExactlyOnceWith(4, { focused: true });
    expect(mocks.tabsCreate).not.toHaveBeenCalled();
  });

  it('navigates the same tab to a different Guide once the page consents', async () => {
    withRegisteredEditor();
    mocks.tabsSendMessage.mockResolvedValue({ ok: true, ready: false });

    await expect(openEditor({ sessionId: 'guide-b' })).resolves.toEqual({ ok: true });

    expect(mocks.tabsUpdate).toHaveBeenCalledExactlyOnceWith(12, {
      url: `${EDITOR_URL_PREFIX}?sessionId=guide-b`,
      active: true,
    });
    expect(mocks.tabsCreate).not.toHaveBeenCalled();
  });

  it('surfaces a draft-blocked refusal through OpenEditorResult and still focuses the tab', async () => {
    withRegisteredEditor();
    mocks.tabsSendMessage.mockResolvedValue({ ok: false, error: '需要先確認要保留哪一份草稿。' });

    await expect(openEditor({ sessionId: 'guide-b' })).resolves.toEqual({
      ok: false,
      error: '需要先確認要保留哪一份草稿。',
    });

    // Focused, not navigated: the page keeps its draft on screen.
    expect(mocks.tabsUpdate).toHaveBeenCalledExactlyOnceWith(12, { active: true });
    expect(mocks.tabsCreate).not.toHaveBeenCalled();
  });

  it('navigates a tab that answers with an unshaped reply', async () => {
    withRegisteredEditor();
    mocks.tabsSendMessage.mockResolvedValue({ ok: true });

    await expect(openEditor({ sessionId: 'guide-b' })).resolves.toEqual({ ok: true });

    expect(mocks.tabsUpdate).toHaveBeenCalledExactlyOnceWith(12, {
      url: `${EDITOR_URL_PREFIX}?sessionId=guide-b`,
      active: true,
    });
    expect(mocks.tabsCreate).not.toHaveBeenCalled();
  });

  it('navigates a tab that answers nothing at all but still exists', async () => {
    // A discarded or reloading tab has no listener; nothing there is worth
    // preserving, so the record stays good and the tab is reused.
    withRegisteredEditor();
    mocks.tabsSendMessage.mockRejectedValue(new Error('Could not establish connection.'));

    await expect(openEditor({ sessionId: 'guide-b' })).resolves.toEqual({ ok: true });

    expect(mocks.tabsGet).toHaveBeenCalledWith(12);
    expect(mocks.tabsUpdate).toHaveBeenCalledExactlyOnceWith(12, {
      url: `${EDITOR_URL_PREFIX}?sessionId=guide-b`,
      active: true,
    });
    expect(mocks.tabsCreate).not.toHaveBeenCalled();
  });

  it('drops a record whose tab is gone and creates one editor instead', async () => {
    withRegisteredEditor();
    mocks.tabsSendMessage.mockRejectedValue(new Error('Could not establish connection.'));
    mocks.tabsGet.mockRejectedValue(new Error('No tab with id: 12.'));

    await expect(openEditor({ sessionId: 'guide-b' })).resolves.toEqual({ ok: true });

    expect(mocks.sessionRemove).toHaveBeenCalledWith(EDITOR_KEY);
    expect(mocks.tabsUpdate).not.toHaveBeenCalled();
    expect(mocks.tabsCreate).toHaveBeenCalledExactlyOnceWith({
      url: `${EDITOR_URL_PREFIX}?sessionId=guide-b`,
      active: true,
    });
  });

  it('reports a missing Guide without touching any tab', async () => {
    withRegisteredEditor();
    mocks.getGuide.mockResolvedValue(undefined);

    await expect(openEditor({ sessionId: 'guide-gone' })).resolves.toEqual({
      ok: false,
      error: '找不到這份內容。',
    });

    expect(mocks.tabsSendMessage).not.toHaveBeenCalled();
    expect(mocks.tabsCreate).not.toHaveBeenCalled();
  });

  it('focuses whatever the open editor shows when recovery can name no Guide', async () => {
    withRegisteredEditor();

    await expect(openEditor()).resolves.toEqual({ ok: true });

    // No Guide to hand over means no handshake to negotiate.
    expect(mocks.tabsSendMessage).not.toHaveBeenCalled();
    expect(mocks.tabsUpdate).toHaveBeenCalledExactlyOnceWith(12, { active: true });
    expect(mocks.tabsCreate).not.toHaveBeenCalled();
  });

  it('marks editor recovery when opening throws, and reports the retry message', async () => {
    silenceIntentionalErrorLogs();
    storedState = makeRecordingState({ sessionId: 'guide-a' });
    mocks.sessionGet.mockRejectedValue(new Error('session storage is unavailable'));

    await expect(openEditor({ sessionId: 'guide-a' })).resolves.toEqual({
      ok: false,
      error: '無法開啟編輯器，請再試一次。',
    });

    expect(storedState.recoverableError?.code).toBe('EDITOR_OPEN_FAILED');
  });
});

describe('finishing a recording twice', () => {
  it('reuses the editor opened by the first finish', async () => {
    storedState = makeRecordingState({
      operation: 'recording',
      isRecording: true,
      phase: 'recording',
      sessionId: 'guide-a',
      tabId: 4,
      runId: 'run-1',
    });
    mocks.tabsGet.mockResolvedValue({ id: 4, windowId: 1, active: true, url: 'https://example.com/flow' });

    const first = await mocks.messageListener?.(
      { type: 'FINISH_RECORDING', runId: 'run-1' },
      EXTENSION_PAGE_SENDER,
    );
    await flushAsyncWork();
    expect(first).toMatchObject({ ok: true });
    expect(mocks.tabsCreate).toHaveBeenCalledTimes(1);

    // The created tab announces itself, exactly as the editor page does on mount.
    withRegisteredEditor();
    mocks.tabsSendMessage.mockResolvedValue({ ok: true, ready: true });
    await openEditor({ sessionId: 'guide-a' });

    expect(mocks.tabsCreate).toHaveBeenCalledTimes(1);
  });
});
