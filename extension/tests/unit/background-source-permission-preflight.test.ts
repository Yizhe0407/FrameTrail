import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  BackgroundMessage,
  PreflightGuideContinuationSourcePermissionResult,
  PreflightStepRecaptureSourcePermissionResult,
  RecordingState,
  StartRecordingResult,
} from '@/lib/runtime/messages';
import type { Step } from '@/lib/storage/db';

const mocks = vi.hoisted(() => ({
  messageListener: null as null | ((message: unknown, sender: unknown) => unknown),
  getGuide: vi.fn(),
  getStep: vi.fn(),
  getSteps: vi.fn(),
  getRecordingState: vi.fn(),
  setRecordingState: vi.fn(),
  permissionsContains: vi.fn(),
  permissionsRequest: vi.fn(),
  tabsQuery: vi.fn(),
  tabsCreate: vi.fn(),
  tabsGet: vi.fn(),
  tabsUpdate: vi.fn(),
  tabsRemove: vi.fn(),
  executeScript: vi.fn(),
  insertCSS: vi.fn(),
}));

vi.mock('wxt/browser', () => ({
  browser: {
    runtime: {
      getURL: (path: string) => `chrome-extension://extension-id${path}`,
      onMessage: {
        addListener: (listener: typeof mocks.messageListener) => {
          mocks.messageListener = listener;
        },
      },
      onConnect: { addListener: vi.fn() },
      sendMessage: vi.fn(),
    },
    commands: { onCommand: { addListener: vi.fn() } },
    permissions: {
      contains: mocks.permissionsContains,
      request: mocks.permissionsRequest,
    },
    tabs: {
      captureVisibleTab: vi.fn(),
      create: mocks.tabsCreate,
      get: mocks.tabsGet,
      onRemoved: { addListener: vi.fn() },
      onUpdated: { addListener: vi.fn() },
      query: mocks.tabsQuery,
      remove: mocks.tabsRemove,
      sendMessage: vi.fn(),
      update: mocks.tabsUpdate,
    },
    windows: { update: vi.fn() },
    scripting: {
      executeScript: mocks.executeScript,
      insertCSS: mocks.insertCSS,
      removeCSS: vi.fn(),
    },
  },
}));

vi.mock('@/lib/storage/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/storage/db')>();
  return {
    ...actual,
    getGuide: mocks.getGuide,
    getStep: mocks.getStep,
    getSteps: mocks.getSteps,
  };
});

vi.mock('@/lib/storage/storage', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/storage/storage')>();
  return {
    ...actual,
    getRecordingState: mocks.getRecordingState,
    setRecordingState: mocks.setRecordingState,
  };
});

const idleState: RecordingState = {
  operation: null,
  isRecording: false,
  phase: 'idle',
  sessionId: null,
  tabId: null,
  error: null,
  recoverableError: null,
  mode: 'steps',
  itemCount: 0,
  numbered: true,
  groupAnchorId: null,
  runId: null,
  snapshotViewport: null,
  snapshotDevicePixelRatio: null,
  recapture: null,
  recaptureResult: null,
};

const editorUrl = 'chrome-extension://extension-id/editor.html';

function editorSender(frameSession: string, tabSession = frameSession) {
  return {
    frameId: 0,
    url: `${editorUrl}?sessionId=${encodeURIComponent(frameSession)}&entryId=step-1`,
    tab: {
      id: 7,
      windowId: 3,
      url: `${editorUrl}?entryId=step-1&sessionId=${encodeURIComponent(tabSession)}`,
    },
  };
}

function ordinaryStep(overrides: Partial<Step> = {}): Step {
  return {
    id: 'step-1',
    sessionId: 'guide-a',
    order: 0,
    screenshotBlob: new Blob(['image']),
    bounds: { x: 1, y: 2, width: 30, height: 40 },
    devicePixelRatio: 2,
    screenshotScale: 2,
    description: 'Persisted step',
    url: 'https://persisted.example/path?fresh=1#target',
    timestamp: 1,
    ...overrides,
  };
}

async function send<T>(message: BackgroundMessage, sender: unknown = editorSender('guide-a')): Promise<T> {
  if (!mocks.messageListener) throw new Error('Background message listener was not registered.');
  return await mocks.messageListener(message, sender) as T;
}

function expectNoPermissionOrOperationSideEffects(): void {
  expect(mocks.getRecordingState).not.toHaveBeenCalled();
  expect(mocks.permissionsContains).not.toHaveBeenCalled();
  expect(mocks.permissionsRequest).not.toHaveBeenCalled();
  expect(mocks.tabsQuery).not.toHaveBeenCalled();
  expect(mocks.tabsCreate).not.toHaveBeenCalled();
  expect(mocks.tabsUpdate).not.toHaveBeenCalled();
  expect(mocks.tabsRemove).not.toHaveBeenCalled();
  expect(mocks.executeScript).not.toHaveBeenCalled();
  expect(mocks.insertCSS).not.toHaveBeenCalled();
  expect(mocks.setRecordingState).not.toHaveBeenCalled();
}

function activeRecordingState(): RecordingState {
  return {
    ...idleState,
    operation: 'recording',
    isRecording: true,
    phase: 'recording',
    sessionId: 'guide-a',
    tabId: 4,
    runId: 'run-1',
  };
}

beforeAll(async () => {
  // This suite deliberately drives the background through rejection paths and
  // starts it without indexedDB/scripting; every resulting log line is the
  // expected defensive logging, so keep it out of the test run output. The
  // spies stay installed for the whole worker-isolated file.
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.stubGlobal('defineBackground', (setup: () => unknown) => setup());
  mocks.getRecordingState.mockResolvedValue(idleState);
  await import('@/entrypoints/background');
  await Promise.resolve();
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getRecordingState.mockResolvedValue(idleState);
  mocks.getGuide.mockResolvedValue({ id: 'guide-a', title: 'Guide A' });
  mocks.getStep.mockResolvedValue(ordinaryStep());
  mocks.getSteps.mockResolvedValue([ordinaryStep()]);
});



describe('background runtime boundary', () => {
  it.each<unknown>([
    null,
    [],
    { type: 'START_RECORDING', sessionId: '', mode: 'steps' },
    { type: 'FRAME_TRAIL_CLICK', runId: 'run-1' },
  ])('ignores malformed messages before any privileged work %#', async (message) => {
    const result = await mocks.messageListener?.(message, editorSender('guide-a'));

    expect(result).toBeUndefined();
    expectNoPermissionOrOperationSideEffects();
    expect(mocks.tabsQuery).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: 'web content script',
      sender: { frameId: 0, url: 'https://example.com/', tab: { id: 4, url: 'https://example.com/' } },
    },
    {
      name: 'foreign extension page',
      sender: { url: 'chrome-extension://foreign-extension/popup.html' },
    },
    {
      name: 'extension child frame',
      sender: {
        frameId: 1,
        url: 'chrome-extension://extension-id/editor.html',
        tab: { id: 4, url: 'chrome-extension://extension-id/editor.html' },
      },
    },
  ])('rejects START_RECORDING from an untrusted $name', async ({ sender }) => {
    const result = await mocks.messageListener?.({
      type: 'START_RECORDING',
      sessionId: 'guide-a',
      mode: 'steps',
    }, sender);

    expect(result).toBeUndefined();
    expectNoPermissionOrOperationSideEffects();
    expect(mocks.tabsQuery).not.toHaveBeenCalled();
  });

  it('accepts toolbar controls from the active recorder top frame', async () => {
    mocks.getRecordingState.mockResolvedValue(activeRecordingState());

    const result = await send<{ ok: boolean }>(
      { type: 'PAUSE_RECORDING', runId: 'run-1' },
      {
        frameId: 0,
        url: 'https://example.com/',
        tab: { id: 4, url: 'https://example.com/' },
      },
    );

    expect(result).toEqual({ ok: true });
    expect(mocks.setRecordingState).toHaveBeenCalledWith(
      expect.objectContaining({ runId: 'run-1', phase: 'paused' }),
    );
  });

  it('rejects toolbar controls from a different tab before mutation', async () => {
    mocks.getRecordingState.mockResolvedValue(activeRecordingState());

    const result = await send<{ ok: boolean }>(
      { type: 'PAUSE_RECORDING', runId: 'run-1' },
      {
        frameId: 0,
        url: 'https://example.com/',
        tab: { id: 5, url: 'https://example.com/' },
      },
    );

    expect(result).toMatchObject({ ok: false });
    expect(mocks.setRecordingState).not.toHaveBeenCalled();
  });
});

describe('continuation recording start', () => {
  it('refuses a continuation whose editor does not own the named Guide', async () => {
    const result = await send<StartRecordingResult>({
      type: 'START_RECORDING',
      sessionId: 'guide-b',
      mode: 'steps',
      continuation: {},
    }, editorSender('guide-a'));

    expect(result).toMatchObject({ ok: false });
    expect(mocks.permissionsContains).not.toHaveBeenCalled();
    expect(mocks.tabsCreate).not.toHaveBeenCalled();
    expect(mocks.setRecordingState).not.toHaveBeenCalled();
  });

  it('refuses a continuation before opening any tab when the source host is not granted', async () => {
    mocks.permissionsContains.mockResolvedValue(false);

    const result = await send<StartRecordingResult>({
      type: 'START_RECORDING',
      sessionId: 'guide-a',
      mode: 'steps',
      continuation: {},
    });

    expect(result).toMatchObject({ ok: false });
    expect(mocks.permissionsContains).toHaveBeenCalledWith({ origins: ['https://persisted.example/*'] });
    expect(mocks.permissionsRequest).not.toHaveBeenCalled();
    expect(mocks.tabsCreate).not.toHaveBeenCalled();
    expect(mocks.setRecordingState).not.toHaveBeenCalled();
  });

  it('records into the Guide\'s own source page rather than the active tab', async () => {
    const sourceTab = {
      id: 11,
      windowId: 5,
      url: 'https://persisted.example/path?fresh=1#target',
      status: 'complete',
    };
    mocks.permissionsContains.mockResolvedValue(true);
    mocks.tabsQuery.mockResolvedValue([sourceTab]);
    mocks.tabsGet.mockResolvedValue(sourceTab);
    // Ends the run at injection: everything under test happens before it.
    mocks.executeScript.mockRejectedValue(new Error('scripting is unavailable in tests'));

    await send<StartRecordingResult>({
      type: 'START_RECORDING',
      sessionId: 'guide-a',
      mode: 'steps',
      continuation: {},
    });

    // The only tabs.query is the exact-URL source lookup: an editor-initiated
    // run must never fall back to whatever tab is currently active.
    expect(mocks.tabsQuery).toHaveBeenCalledTimes(1);
    expect(mocks.tabsQuery).toHaveBeenCalledWith({});
    expect(mocks.tabsCreate).not.toHaveBeenCalled();
    expect(mocks.tabsUpdate).toHaveBeenCalledWith(11, { active: true });
    expect(mocks.setRecordingState).toHaveBeenCalledWith(
      expect.objectContaining({ operation: 'recording', sessionId: 'guide-a', tabId: 11 }),
    );
  });
});

describe('background source-permission preflight', () => {
  it('rejects a forged editor/session before reading a recapture target', async () => {
    const result = await send<PreflightStepRecaptureSourcePermissionResult>({
      type: 'PREFLIGHT_STEP_RECAPTURE_SOURCE_PERMISSION',
      sessionId: 'guide-b',
      target: { kind: 'single', stepId: 'step-1' },
    }, editorSender('guide-a'));

    expect(result).toMatchObject({ ok: false, code: 'INVALID_EDITOR' });
    expect(mocks.getStep).not.toHaveBeenCalled();
    expectNoPermissionOrOperationSideEffects();
  });

  it('rejects a missing or structurally changed recapture target', async () => {
    mocks.getStep.mockResolvedValueOnce(undefined);
    const missing = await send<PreflightStepRecaptureSourcePermissionResult>({
      type: 'PREFLIGHT_STEP_RECAPTURE_SOURCE_PERMISSION',
      sessionId: 'guide-a',
      target: { kind: 'single', stepId: 'step-1' },
    });

    mocks.getStep.mockResolvedValueOnce(ordinaryStep({ screenshotBlob: undefined }));
    const changed = await send<PreflightStepRecaptureSourcePermissionResult>({
      type: 'PREFLIGHT_STEP_RECAPTURE_SOURCE_PERMISSION',
      sessionId: 'guide-a',
      target: { kind: 'single', stepId: 'step-1' },
    });

    expect(missing).toMatchObject({ ok: false, code: 'TARGET_NOT_FOUND' });
    expect(changed).toMatchObject({ ok: false, code: 'TARGET_CHANGED' });
    expectNoPermissionOrOperationSideEffects();
  });

  it('rejects a restricted persisted recapture URL', async () => {
    mocks.getStep.mockResolvedValue(ordinaryStep({ url: 'https://chromewebstore.google.com/detail/test' }));
    const result = await send<PreflightStepRecaptureSourcePermissionResult>({
      type: 'PREFLIGHT_STEP_RECAPTURE_SOURCE_PERMISSION',
      sessionId: 'guide-a',
      target: { kind: 'single', stepId: 'step-1' },
    });

    expect(result).toMatchObject({ ok: false, code: 'RESTRICTED_SOURCE' });
    expectNoPermissionOrOperationSideEffects();
  });

  it('resolves continuation authority from the Guide\'s last persisted step', async () => {
    mocks.getSteps.mockResolvedValue([
      ordinaryStep({ id: 'step-1', order: 0, url: 'https://first.example/start' }),
      ordinaryStep({ id: 'step-2', order: 1, url: 'https://persisted.example/path?fresh=1#target' }),
    ]);

    const result = await send<PreflightGuideContinuationSourcePermissionResult>({
      type: 'PREFLIGHT_GUIDE_CONTINUATION_SOURCE_PERMISSION',
      sessionId: 'guide-a',
      sourceUrl: 'https://stale-ui.example/wrong',
    } as BackgroundMessage);

    expect(result).toEqual({
      ok: true,
      sourceUrl: 'https://persisted.example/path?fresh=1#target',
      sourceOrigin: 'https://persisted.example',
      permissionPattern: 'https://persisted.example/*',
    });
    expectNoPermissionOrOperationSideEffects();
  });

  it('rejects continuation for a forged editor, an empty Guide, or a restricted source', async () => {
    const forged = await send<PreflightGuideContinuationSourcePermissionResult>({
      type: 'PREFLIGHT_GUIDE_CONTINUATION_SOURCE_PERMISSION',
      sessionId: 'guide-b',
    }, editorSender('guide-a'));

    mocks.getSteps.mockResolvedValueOnce([]);
    const empty = await send<PreflightGuideContinuationSourcePermissionResult>({
      type: 'PREFLIGHT_GUIDE_CONTINUATION_SOURCE_PERMISSION',
      sessionId: 'guide-a',
    });

    mocks.getSteps.mockResolvedValueOnce([ordinaryStep({ url: 'chrome://settings' })]);
    const restricted = await send<PreflightGuideContinuationSourcePermissionResult>({
      type: 'PREFLIGHT_GUIDE_CONTINUATION_SOURCE_PERMISSION',
      sessionId: 'guide-a',
    });

    expect(forged).toMatchObject({ ok: false, code: 'INVALID_EDITOR' });
    expect(empty).toMatchObject({ ok: false, code: 'SOURCE_NOT_FOUND' });
    expect(restricted).toMatchObject({ ok: false, code: 'RESTRICTED_SOURCE' });
    expectNoPermissionOrOperationSideEffects();
  });

  it('uses only persisted recapture authority and ignores a UI-provided URL', async () => {
    const result = await send<PreflightStepRecaptureSourcePermissionResult>({
      type: 'PREFLIGHT_STEP_RECAPTURE_SOURCE_PERMISSION',
      sessionId: 'guide-a',
      target: { kind: 'single', stepId: 'step-1' },
      sourceUrl: 'https://stale-ui.example/wrong',
    } as BackgroundMessage);

    expect(result).toEqual({
      ok: true,
      sourceUrl: 'https://persisted.example/path?fresh=1#target',
      sourceOrigin: 'https://persisted.example',
      permissionPattern: 'https://persisted.example/*',
    });
    expectNoPermissionOrOperationSideEffects();
  });
});
