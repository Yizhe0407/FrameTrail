import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  BackgroundMessage,
  PreflightInsertionSourcePermissionResult,
  PreflightStepRecaptureSourcePermissionResult,
  RecordingState,
} from '@/lib/runtime/messages';
import type { Step } from '@/lib/storage/db';

const mocks = vi.hoisted(() => ({
  messageListener: null as null | ((message: unknown, sender: unknown) => unknown),
  getInsertionAnchor: vi.fn(),
  getStep: vi.fn(),
  getSteps: vi.fn(),
  getRecordingState: vi.fn(),
  setRecordingState: vi.fn(),
  permissionsContains: vi.fn(),
  permissionsRequest: vi.fn(),
  tabsQuery: vi.fn(),
  tabsCreate: vi.fn(),
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
      get: vi.fn(),
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
    getInsertionAnchor: mocks.getInsertionAnchor,
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
  insertion: null,
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
  vi.stubGlobal('defineBackground', (setup: () => unknown) => setup());
  mocks.getRecordingState.mockResolvedValue(idleState);
  await import('@/entrypoints/background');
  await Promise.resolve();
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getRecordingState.mockResolvedValue(idleState);
  mocks.getInsertionAnchor.mockResolvedValue({
    anchorEntryId: 'step-1',
    kind: 'single',
    sourceUrl: 'https://persisted.example/path?fresh=1#target',
    memberIds: ['step-1'],
  });
  mocks.getStep.mockResolvedValue(ordinaryStep());
  mocks.getSteps.mockResolvedValue([ordinaryStep()]);
});



describe('background runtime boundary', () => {
  it.each<unknown>([
    null,
    [],
    { type: 'START_RECORDING', sessionId: '', mode: 'steps', numbered: true },
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
      numbered: true,
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

describe('background source-permission preflight', () => {
  it.each([
    {
      name: 'insertion',
      message: {
        type: 'PREFLIGHT_INSERTION_SOURCE_PERMISSION',
        sessionId: 'guide-b',
        anchorEntryId: 'step-1',
      } as const,
    },
    {
      name: 'recapture',
      message: {
        type: 'PREFLIGHT_STEP_RECAPTURE_SOURCE_PERMISSION',
        sessionId: 'guide-b',
        target: { kind: 'single', stepId: 'step-1' },
      } as const,
    },
  ])('rejects a forged editor/session for $name before reading a target', async ({ message }) => {
    const result = await send<
      PreflightInsertionSourcePermissionResult | PreflightStepRecaptureSourcePermissionResult
    >(message, editorSender('guide-a'));

    expect(result).toMatchObject({ ok: false, code: 'INVALID_EDITOR' });
    expect(mocks.getInsertionAnchor).not.toHaveBeenCalled();
    expect(mocks.getStep).not.toHaveBeenCalled();
    expectNoPermissionOrOperationSideEffects();
  });

  it.each([
    ['ANCHOR_NOT_FOUND', 'ANCHOR_NOT_FOUND'],
    ['ANCHOR_CHANGED', 'ANCHOR_CHANGED'],
    ['RUN_STATE_CHANGED', 'ANCHOR_CHANGED'],
  ] as const)('maps insertion DB %s to typed %s', async (dbCode, expectedCode) => {
    const { InsertionRecordingError } = await import('@/lib/storage/db');
    mocks.getInsertionAnchor.mockRejectedValue(new InsertionRecordingError(dbCode, 'stale target'));

    const result = await send<PreflightInsertionSourcePermissionResult>({
      type: 'PREFLIGHT_INSERTION_SOURCE_PERMISSION',
      sessionId: 'guide-a',
      anchorEntryId: 'step-1',
    });

    expect(result).toMatchObject({ ok: false, code: expectedCode });
    if (!result.ok) expect(result.message).toBeTruthy();
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

  it.each([
    {
      name: 'insertion',
      setup: () => mocks.getInsertionAnchor.mockResolvedValue({
        anchorEntryId: 'step-1',
        kind: 'single',
        sourceUrl: 'chrome://settings/privacy',
        memberIds: ['step-1'],
      }),
      message: {
        type: 'PREFLIGHT_INSERTION_SOURCE_PERMISSION',
        sessionId: 'guide-a',
        anchorEntryId: 'step-1',
      } as const,
    },
    {
      name: 'recapture',
      setup: () => mocks.getStep.mockResolvedValue(ordinaryStep({ url: 'https://chromewebstore.google.com/detail/test' })),
      message: {
        type: 'PREFLIGHT_STEP_RECAPTURE_SOURCE_PERMISSION',
        sessionId: 'guide-a',
        target: { kind: 'single', stepId: 'step-1' },
      } as const,
    },
  ])('rejects a restricted persisted URL for $name', async ({ setup, message }) => {
    setup();
    const result = await send<
      PreflightInsertionSourcePermissionResult | PreflightStepRecaptureSourcePermissionResult
    >(message);

    expect(result).toMatchObject({ ok: false, code: 'RESTRICTED_SOURCE' });
    expectNoPermissionOrOperationSideEffects();
  });

  it.each([
    {
      name: 'insertion',
      message: {
        type: 'PREFLIGHT_INSERTION_SOURCE_PERMISSION',
        sessionId: 'guide-a',
        anchorEntryId: 'step-1',
        sourceUrl: 'https://stale-ui.example/wrong',
      } as BackgroundMessage,
    },
    {
      name: 'recapture',
      message: {
        type: 'PREFLIGHT_STEP_RECAPTURE_SOURCE_PERMISSION',
        sessionId: 'guide-a',
        target: { kind: 'single', stepId: 'step-1' },
        sourceUrl: 'https://stale-ui.example/wrong',
      } as BackgroundMessage,
    },
  ])('returns only the persisted authority for $name and ignores any runtime UI URL', async ({ message }) => {
    const result = await send<
      PreflightInsertionSourcePermissionResult | PreflightStepRecaptureSourcePermissionResult
    >(message);

    expect(result).toEqual({
      ok: true,
      sourceUrl: 'https://persisted.example/path?fresh=1#target',
      sourceOrigin: 'https://persisted.example',
      permissionPattern: 'https://persisted.example/*',
    });
    expectNoPermissionOrOperationSideEffects();
  });
});
