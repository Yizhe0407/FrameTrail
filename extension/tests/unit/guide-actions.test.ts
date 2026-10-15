import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  createGuide: vi.fn(),
  getGuide: vi.fn(),
  discardPristineGuide: vi.fn(),
  getActiveGuideId: vi.fn(),
  setActiveGuideId: vi.fn(),
  clearActiveGuideId: vi.fn(),
  getRecordingState: vi.fn(),
  sendMessage: vi.fn(),
}));

vi.mock('wxt/browser', () => ({ browser: { runtime: { sendMessage: mocks.sendMessage } } }));
vi.mock('@/lib/storage/guide-repository', () => ({
  createGuide: mocks.createGuide,
  getGuide: mocks.getGuide,
  discardPristineGuide: mocks.discardPristineGuide,
}));
vi.mock('@/lib/storage/storage', () => ({
  getActiveGuideId: mocks.getActiveGuideId,
  setActiveGuideId: mocks.setActiveGuideId,
  clearActiveGuideId: mocks.clearActiveGuideId,
  getRecordingState: mocks.getRecordingState,
}));

import {
  clearSelectedGuide,
  discardUntouchedGuide,
  ensureSelectedGuide,
  getSelectedGuide,
  openSelectedGuideInEditor,
  selectGuide,
  startRecordingIntoGuide,
} from '@/lib/guide/guide-actions';

function guide(id: string) {
  return {
    id,
    title: id,
    description: '',
    createdAt: 1,
    updatedAt: 1,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.setActiveGuideId.mockResolvedValue(undefined);
  mocks.clearActiveGuideId.mockResolvedValue(true);
  mocks.sendMessage.mockResolvedValue({ ok: true });
});

describe('Guide UI selection', () => {
  it('selects through ACTIVE_GUIDE_ID without reading or replacing RecordingState', async () => {
    mocks.getGuide.mockResolvedValue(guide('guide-a'));

    await expect(selectGuide('guide-a')).resolves.toMatchObject({ id: 'guide-a' });

    expect(mocks.getGuide).toHaveBeenCalledWith('guide-a');
    expect(mocks.setActiveGuideId).toHaveBeenCalledWith('guide-a');
  });

  it('preserves invocation order when an earlier Guide lookup resolves slowly', async () => {
    const first = deferred<ReturnType<typeof guide>>();
    mocks.getGuide.mockImplementation((id: string) =>
      id === 'guide-a' ? first.promise : Promise.resolve(guide(id)),
    );

    const selectingA = selectGuide('guide-a');
    const selectingB = selectGuide('guide-b');
    await Promise.resolve();
    expect(mocks.getGuide).toHaveBeenCalledTimes(1);

    first.resolve(guide('guide-a'));
    await Promise.all([selectingA, selectingB]);

    expect(mocks.setActiveGuideId.mock.calls).toEqual([['guide-a'], ['guide-b']]);
  });

  it('creates a fresh Guide for a stale selection instead of resurrecting its deleted id', async () => {
    mocks.getActiveGuideId.mockResolvedValue('deleted-guide');
    mocks.getGuide.mockResolvedValue(undefined);
    mocks.createGuide.mockResolvedValue(guide('fresh-guide'));

    await expect(ensureSelectedGuide()).resolves.toMatchObject({ id: 'fresh-guide' });

    expect(mocks.clearActiveGuideId).toHaveBeenCalledWith('deleted-guide');
    expect(mocks.createGuide).toHaveBeenCalledOnce();
    expect(mocks.setActiveGuideId).toHaveBeenCalledWith('fresh-guide');
  });

  it('sends an explicit sessionId when opening the selected Guide', async () => {
    mocks.getGuide.mockResolvedValue(guide('guide-a'));

    await openSelectedGuideInEditor('guide-a');

    expect(mocks.sendMessage).toHaveBeenCalledWith({
      type: 'OPEN_EDITOR',
      sessionId: 'guide-a',
    });
  });


  it('reports a missing background response instead of dereferencing undefined', async () => {
    mocks.getGuide.mockResolvedValue(guide('guide-a'));
    mocks.sendMessage.mockResolvedValue(undefined);

    await expect(openSelectedGuideInEditor('guide-a')).rejects.toThrow('無法連接編輯器服務');
  });

  it('compare-and-clears selection without consulting capture operation state', async () => {
    await clearSelectedGuide('guide-a');

    expect(mocks.clearActiveGuideId).toHaveBeenCalledWith('guide-a');
  });

  it('reads the selected Guide without clearing a stale selection', async () => {
    mocks.getActiveGuideId.mockResolvedValue('deleted-guide');
    mocks.getGuide.mockResolvedValue(undefined);

    await expect(getSelectedGuide()).resolves.toBeNull();

    expect(mocks.clearActiveGuideId).not.toHaveBeenCalled();
    expect(mocks.setActiveGuideId).not.toHaveBeenCalled();
  });
});

// The pristine guard itself lives in lib/storage (see tests/integration/db-pristine-guide.test.ts); this suite covers only the UI-flow wrapper: delegation and restoring the prior selection.
describe('auto-created Guide reclamation', () => {
  it('delegates deletion to storage and restores the previous selection', async () => {
    mocks.discardPristineGuide.mockResolvedValue(true);
    mocks.getGuide.mockImplementation(async (id: string) => guide(id));

    await expect(discardUntouchedGuide('guide-fresh', 'guide-old')).resolves.toBe(true);

    expect(mocks.discardPristineGuide).toHaveBeenCalledExactlyOnceWith('guide-fresh');
    expect(mocks.setActiveGuideId).toHaveBeenCalledWith('guide-old');
  });

  it('does not restore anything when storage declined to delete', async () => {
    mocks.discardPristineGuide.mockResolvedValue(false);

    await expect(discardUntouchedGuide('guide-touched', 'guide-old')).resolves.toBe(false);

    expect(mocks.setActiveGuideId).not.toHaveBeenCalled();
  });

  it('skips restoring a previous selection that no longer exists', async () => {
    mocks.discardPristineGuide.mockResolvedValue(true);
    mocks.getGuide.mockResolvedValue(undefined);

    await expect(discardUntouchedGuide('guide-fresh', 'guide-gone')).resolves.toBe(true);

    expect(mocks.setActiveGuideId).not.toHaveBeenCalled();
  });

  it('never re-selects the guide it just discarded', async () => {
    mocks.discardPristineGuide.mockResolvedValue(true);
    mocks.getGuide.mockImplementation(async (id: string) => guide(id));

    await expect(discardUntouchedGuide('guide-fresh', 'guide-fresh')).resolves.toBe(true);

    expect(mocks.setActiveGuideId).not.toHaveBeenCalled();
  });
});

describe('popup start transaction (startRecordingIntoGuide)', () => {
  beforeEach(() => {
    mocks.getActiveGuideId.mockResolvedValue('guide-old');
    mocks.getGuide.mockImplementation(async (id: string) => guide(id));
    mocks.createGuide.mockResolvedValue(guide('guide-new'));
    mocks.getRecordingState.mockResolvedValue({ isRecording: false, sessionId: null });
  });

  it('creates, selects, and starts recording into a fresh guide', async () => {
    mocks.sendMessage.mockResolvedValue({ ok: true, sessionId: 'guide-new', runId: 'run-1' });

    await expect(startRecordingIntoGuide('steps')).resolves.toMatchObject({ id: 'guide-new' });

    expect(mocks.sendMessage).toHaveBeenCalledWith({
      type: 'START_RECORDING',
      sessionId: 'guide-new',
      mode: 'steps',
      autoCreatedGuide: true,
    });
    expect(mocks.discardPristineGuide).not.toHaveBeenCalled();
  });

  it('rolls back the fresh guide and restores the previous selection on failure', async () => {
    mocks.sendMessage.mockResolvedValue({ ok: false, error: '此頁面不允許錄製。' });
    mocks.discardPristineGuide.mockResolvedValue(true);

    await expect(startRecordingIntoGuide('steps')).rejects.toThrow('此頁面不允許錄製');

    expect(mocks.discardPristineGuide).toHaveBeenCalledExactlyOnceWith('guide-new');
    expect(mocks.setActiveGuideId).toHaveBeenLastCalledWith('guide-old');
  });

  it('keeps the fresh guide when the run actually started but the response was lost', async () => {
    mocks.sendMessage.mockResolvedValue(undefined);
    mocks.getRecordingState.mockResolvedValue({ isRecording: true, sessionId: 'guide-new' });

    await expect(startRecordingIntoGuide('steps')).rejects.toThrow('無法連接錄製服務');

    expect(mocks.discardPristineGuide).not.toHaveBeenCalled();
  });
});

describe('popup start transaction into an existing guide', () => {
  beforeEach(() => {
    mocks.getActiveGuideId.mockResolvedValue('guide-old');
    mocks.getGuide.mockImplementation(async (id: string) => guide(id));
    mocks.getRecordingState.mockResolvedValue({ isRecording: false, sessionId: null });
  });

  it('selects the target and starts without creating a guide or marking it reclaimable', async () => {
    mocks.sendMessage.mockResolvedValue({ ok: true, sessionId: 'guide-target', runId: 'run-1' });

    await expect(startRecordingIntoGuide('steps', 'guide-target')).resolves.toMatchObject({ id: 'guide-target' });

    expect(mocks.createGuide).not.toHaveBeenCalled();
    expect(mocks.setActiveGuideId).toHaveBeenCalledWith('guide-target');
    // No autoCreatedGuide: the background must never reclaim an existing guide.
    expect(mocks.sendMessage).toHaveBeenCalledExactlyOnceWith({
      type: 'START_RECORDING',
      sessionId: 'guide-target',
      mode: 'steps',
    });
  });

  it('restores the previous selection and never deletes the guide when start fails', async () => {
    mocks.sendMessage.mockResolvedValue({ ok: false, error: '此頁面不允許錄製。' });

    await expect(startRecordingIntoGuide('steps', 'guide-target')).rejects.toThrow('此頁面不允許錄製');

    expect(mocks.discardPristineGuide).not.toHaveBeenCalled();
    expect(mocks.setActiveGuideId).toHaveBeenLastCalledWith('guide-old');
  });

  it('keeps the selection when the run actually started but the response was lost', async () => {
    mocks.sendMessage.mockResolvedValue(undefined);
    mocks.getRecordingState.mockResolvedValue({ isRecording: true, sessionId: 'guide-target' });

    await expect(startRecordingIntoGuide('steps', 'guide-target')).rejects.toThrow('無法連接錄製服務');

    expect(mocks.setActiveGuideId).toHaveBeenCalledExactlyOnceWith('guide-target');
  });

  it('fails without starting when the target guide no longer exists', async () => {
    mocks.getGuide.mockImplementation(async (id: string) => (id === 'guide-old' ? guide(id) : undefined));

    await expect(startRecordingIntoGuide('steps', 'guide-gone')).rejects.toThrow('找不到這份內容');

    expect(mocks.sendMessage).not.toHaveBeenCalled();
  });
});
