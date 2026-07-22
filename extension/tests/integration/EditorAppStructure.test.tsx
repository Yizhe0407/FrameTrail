// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const database = vi.hoisted(() => {
  class GuideContentConflictError extends Error {}
  class StepUpdateConflictError extends Error {}

  const entryId = (entry: any) => entry.kind === 'single' ? entry.step.id : entry.anchor.id;

  return {
    GuideContentConflictError,
    StepUpdateConflictError,
    addGuideSectionAtomically: vi.fn(),
    buildStepEntries: vi.fn((steps: any[]) => steps),
    deleteGuideAnnotationAtomically: vi.fn(),
    deleteGuideEntriesAtomically: vi.fn(),
    deleteGuideSectionAtomically: vi.fn(),
    deleteStepsAndReorder: vi.fn(),
    duplicateGuideEntryAtomically: vi.fn(),
    entryId,
    flattenEntries: vi.fn((entries: any[]) => entries.flatMap((entry) => (
      entry.kind === 'single' ? [entry.step] : [entry.anchor, ...entry.annotations]
    ))),
    getGuide: vi.fn(),
    getGuideStructureSnapshot: vi.fn(),
    getSteps: vi.fn(),
    moveGuideEntriesAtomically: vi.fn(),
    renameGuideSectionAtomically: vi.fn(),
    reorderGuideAnnotationsAtomically: vi.fn(),
    reorderGuideEntriesAtomically: vi.fn(),
    reorderSteps: vi.fn(),
    restoreGuideAnnotationAtomically: vi.fn(),
    restoreGuideEntriesAtomically: vi.fn(),
    restoreStepsAndReorder: vi.fn(),
    setGuideEntriesNumberedAtomically: vi.fn(),
    updateGuide: vi.fn(),
    updateGuideVisualsAtomically: vi.fn(),
    updateStepsAtomically: vi.fn(),
  };
});


const browserApi = vi.hoisted(() => ({
  sendMessage: vi.fn(),
  requestPermission: vi.fn(),
}));

const recordingSession = vi.hoisted(() => ({
  useRecordingSession: vi.fn(),
  refresh: vi.fn(),
}));

const editorSave = vi.hoisted(() => ({
  flushAll: vi.fn(),
}));

const rendered = vi.hoisted(() => ({
  stepRailProps: null as any,
  stepStageProps: null as any,
  batchToolbarProps: null as any,
}));

vi.mock('wxt/browser', () => ({
  browser: {
    runtime: {
      getURL: vi.fn((path: string) => `chrome-extension://frametrail${path}`),
      sendMessage: browserApi.sendMessage,
    },
    tabs: {
      create: vi.fn(),
      get: vi.fn(),
      query: vi.fn(),
      sendMessage: vi.fn(),
      update: vi.fn(),
    },
    windows: { update: vi.fn() },
    permissions: { request: browserApi.requestPermission },
  },
}));

vi.mock('@/lib/db', () => database);
vi.mock('@/lib/useRecordingSession', () => ({
  useRecordingSession: recordingSession.useRecordingSession,
}));
vi.mock('@/lib/editor-autosave', () => ({
  EditorSaveProvider: ({ children }: any) => children,
  useEditorSaveRegistry: () => ({ flushAll: editorSave.flushAll }),
}));
vi.mock('@/lib/export-images', () => ({ exportImagesAsZip: vi.fn() }));
vi.mock('@/lib/publication-policy', () => ({ assertPublicationReady: vi.fn() }));
vi.mock('@/lib/guide-quality', () => ({
  DEFAULT_GUIDE_ENTRY_FILTERS: { text: '', kind: 'all', issue: 'all' },
  analyzeGuideQuality: (entries: any[]) => ({
    entries: entries.map((entry, index) => ({
      entryId: database.entryId(entry),
      index,
      issues: [],
    })),
    issueCounts: {
      'empty-description': 0,
      'duplicate-description': 0,
      'redaction-review-required': 0,
      'missing-image': 0,
      'missing-bounds': 0,
      'very-long-guide': 0,
    },
    totalIssueCount: 0,
  }),
  createGuideEntryIndex: (entries: any[]) => entries.map((entry, index) => ({ entry, index })),
  filterGuideEntryIndex: (index: any[]) => index,
}));

vi.mock('@/components/EditorHeader', () => ({ default: () => null }));
vi.mock('@/components/StepRailFilters', () => ({ default: () => null }));
vi.mock('@/components/StepRail', () => ({
  default: (props: any) => {
    rendered.stepRailProps = props;
    return (
      <aside
        aria-label="StepRail test double"
        data-reorder-disabled={String(props.reorderDisabled)}
      >
        <output data-testid="rail-selected">{[...props.selectedEntryIds].join(',')}</output>
        <output data-testid="rail-sections">
          {(props.sections ?? []).map((section: any) => `${section.title}:${section.startEntryId}`).join('|')}
        </output>
        <button
          type="button"
          onClick={() => props.onSelect('entry-2', { additive: true, range: false })}
        >
          Ctrl 選取 entry-2
        </button>
        <button
          type="button"
          onClick={() => props.onSelect('entry-3', { additive: false, range: true })}
        >
          Shift 選取 entry-3
        </button>
      </aside>
    );
  },
}));
vi.mock('@/components/StepStage', () => ({
  default: (props: any) => {
    rendered.stepStageProps = props;
    const id = database.entryId(props.entry);
    return (
      <main
        aria-label="StepStage test double"
        data-entry-id={id}
        data-editing-disabled={String(props.editingDisabled)}
      >
        <button type="button" onClick={() => void props.onSetNumbered(id, false)}>
          關閉目前快照編號
        </button>
        <button type="button" disabled={props.editingDisabled} onClick={() => void props.onRecapture()}>
          準備補拍
        </button>
      </main>
    );
  },
}));
vi.mock('@/components/GuideBatchToolbar', () => ({
  default: (props: any) => {
    rendered.batchToolbarProps = props;
    if (props.selectedEntryIds.length < 2) return null;
    return (
      <section aria-label="GuideBatchToolbar test double">
        {props.selectedEntryIds.join(',')}
      </section>
    );
  },
}));
vi.mock('@/components/InsertionRecordingActions', () => ({
  default: ({ disabled, pending, onStart }: any) => (
    <div data-testid="insertion-actions" data-disabled={String(disabled)} data-pending={String(pending)}>
      <button type="button" disabled={disabled || pending} onClick={() => void onStart('before', 'steps', false)}>
        準備在前方補錄
      </button>
    </div>
  ),
  insertionTargetForEntry: (entry: any) => ({ anchorEntryId: database.entryId(entry) }),
}));
vi.mock('@/components/EmptyState', () => ({ default: () => <div>EmptyState</div> }));
vi.mock('@/components/Lightbox', () => ({ default: () => null }));
vi.mock('@/components/UndoSnackbar', () => ({ default: () => null }));
vi.mock('@/components/GuideQualityDialog', () => ({ default: () => null }));
vi.mock('@/components/PublishGuideDialog', () => ({ default: () => null }));

import EditorApp from '@/entrypoints/editor/App';

const entries = [
  {
    kind: 'group',
    anchor: {
      id: 'entry-1',
      sessionId: 'guide-1',
      order: 0,
      bounds: null,
      devicePixelRatio: 1,
      description: '第一個快照',
      url: 'https://example.test/one',
      timestamp: 1,
      groupId: 'entry-1',
      numbered: true,
      screenshotBlob: new Blob(['one'], { type: 'image/png' }),
    },
    annotations: [],
  },
  {
    kind: 'single',
    step: {
      id: 'entry-2',
      sessionId: 'guide-1',
      order: 1,
      bounds: { x: 1, y: 2, width: 3, height: 4 },
      devicePixelRatio: 1,
      description: '第二步',
      url: 'https://example.test/two',
      timestamp: 2,
      screenshotBlob: new Blob(['two'], { type: 'image/png' }),
    },
  },
  {
    kind: 'single',
    step: {
      id: 'entry-3',
      sessionId: 'guide-1',
      order: 2,
      bounds: { x: 5, y: 6, width: 7, height: 8 },
      devicePixelRatio: 1,
      description: '第三步',
      url: 'https://example.test/three',
      timestamp: 3,
      screenshotBlob: new Blob(['three'], { type: 'image/png' }),
    },
  },
] as any[];

const guide = {
  id: 'guide-1',
  title: '結構測試教學',
  description: '',
  sections: [
    { id: 'section-1', title: '準備', startEntryId: 'entry-1' },
    { id: 'section-2', title: '完成', startEntryId: 'entry-3' },
  ],
  createdAt: 1,
  updatedAt: 2,
  archivedAt: null,
  contentRevision: 7,
};

const emptyEntries: any[] = [];

const idleRecording = {
  sessionId: null,
  operation: null,
  isRecording: false,
  insertion: null,
  recapture: null,
  recaptureResult: null,
  itemCount: 0,
};

function editorSessionResult() {
  return {
    sessionId: 'guide-1',
    tabId: 17,
    steps: entries,
    error: null,
    refresh: recordingSession.refresh,
    recording: idleRecording,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  rendered.stepRailProps = null;
  rendered.stepStageProps = null;
  rendered.batchToolbarProps = null;
  editorSave.flushAll.mockResolvedValue(undefined);
  recordingSession.refresh.mockResolvedValue(undefined);
  recordingSession.useRecordingSession.mockImplementation((explicitSessionId?: string | null) => {
    if (explicitSessionId === 'guide-1') return editorSessionResult();
    if (explicitSessionId === undefined) {
      return {
        ...editorSessionResult(),
        sessionId: 'global-guide',
        recording: { ...idleRecording, sessionId: 'global-guide' },
      };
    }
    return {
      sessionId: null,
      tabId: null,
      steps: emptyEntries,
      error: null,
      refresh: recordingSession.refresh,
      recording: { ...idleRecording, sessionId: 'global-guide' },
    };
  });
  database.getGuide.mockResolvedValue(guide);
  database.getGuideStructureSnapshot.mockResolvedValue({
    guide,
    entries,
    entryIds: entries.map(database.entryId),
  });
  browserApi.sendMessage.mockReset();
  browserApi.requestPermission.mockReset();
  browserApi.requestPermission.mockResolvedValue(true);
  database.setGuideEntriesNumberedAtomically.mockResolvedValue({
    guide: { ...guide, contentRevision: 8 },
    affectedEntryIds: ['entry-1'],
  });
  window.history.replaceState({}, '', '/editor.html?sessionId=guide-1');
});

afterEach(() => {
  cleanup();
  window.history.replaceState({}, '', '/');
});

describe('Editor App structure wiring', () => {
  it('passes selection and Guide sections to StepRail, and applies Ctrl/Shift callback modifiers', async () => {
    render(<EditorApp />);

    await waitFor(() => expect(screen.getByTestId('rail-selected').textContent).toBe('entry-1'));
    expect(screen.getByTestId('rail-sections').textContent).toBe('準備:entry-1|完成:entry-3');
    expect(rendered.stepRailProps.sections).toEqual(guide.sections);
    expect([...rendered.stepRailProps.selectedEntryIds]).toEqual(['entry-1']);

    fireEvent.click(screen.getByRole('button', { name: 'Ctrl 選取 entry-2' }));

    await waitFor(() => expect(screen.getByTestId('rail-selected').textContent).toBe('entry-1,entry-2'));
    expect([...rendered.stepRailProps.selectedEntryIds]).toEqual(['entry-1', 'entry-2']);

    fireEvent.click(screen.getByRole('button', { name: 'Shift 選取 entry-3' }));

    await waitFor(() => expect(screen.getByTestId('rail-selected').textContent).toBe('entry-2,entry-3'));
    expect([...rendered.stepRailProps.selectedEntryIds]).toEqual(['entry-2', 'entry-3']);
  });

  it('disables stage editing and rail DnD, and shows the batch toolbar for multiple selection', async () => {
    render(<EditorApp />);

    await waitFor(() => expect(screen.getByTestId('rail-selected').textContent).toBe('entry-1'));
    expect(screen.queryByLabelText('GuideBatchToolbar test double')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Ctrl 選取 entry-2' }));

    const toolbar = await screen.findByLabelText('GuideBatchToolbar test double');
    expect(toolbar.textContent).toBe('entry-1,entry-2');
    expect(screen.getByLabelText('StepStage test double').getAttribute('data-editing-disabled')).toBe('true');
    expect(screen.getByLabelText('StepRail test double').getAttribute('data-reorder-disabled')).toBe('true');
    expect(rendered.stepStageProps.editingDisabled).toBe(true);
    expect(rendered.stepRailProps.reorderDisabled).toBe(true);
    expect(rendered.batchToolbarProps.selectedEntryIds).toEqual(['entry-1', 'entry-2']);
  });

  it('uses a fresh structure snapshot revision for StepStage onSetNumbered atomic writes', async () => {
    const freshGuide = { ...guide, contentRevision: 41 };
    database.getGuideStructureSnapshot.mockResolvedValue({
      guide: freshGuide,
      entries,
      entryIds: entries.map(database.entryId),
    });
    browserApi.sendMessage.mockReset();
  browserApi.requestPermission.mockReset();
  browserApi.requestPermission.mockResolvedValue(true);
  database.setGuideEntriesNumberedAtomically.mockResolvedValue({
      guide: { ...guide, contentRevision: 42 },
      affectedEntryIds: ['entry-1'],
    });
    render(<EditorApp />);

    await screen.findByRole('button', { name: '關閉目前快照編號' });
    fireEvent.click(screen.getByRole('button', { name: '關閉目前快照編號' }));

    await waitFor(() => expect(database.setGuideEntriesNumberedAtomically).toHaveBeenCalledOnce());
    expect(database.getGuideStructureSnapshot).toHaveBeenCalledWith('guide-1');
    expect(database.setGuideEntriesNumberedAtomically).toHaveBeenCalledWith(
      'guide-1',
      ['entry-1'],
      false,
      41,
    );
    expect(database.getGuideStructureSnapshot.mock.invocationCallOrder[0]).toBeLessThan(
      database.setGuideEntriesNumberedAtomically.mock.invocationCallOrder[0],
    );
  });

  it('preflights insertion from persisted data and requests permission only after explicit confirmation', async () => {
    browserApi.sendMessage.mockImplementation(async (message: any) => {
      if (message.type === 'PREFLIGHT_INSERTION_SOURCE_PERMISSION') {
        return {
          ok: true,
          sourceUrl: 'https://persisted.example/path',
          sourceOrigin: 'https://persisted.example',
          permissionPattern: 'https://persisted.example/*',
        };
      }
      if (message.type === 'START_INSERTION_RECORDING') return { ok: true, runId: 'run-1' };
      return { ok: true };
    });
    render(<EditorApp />);

    await screen.findByRole('button', { name: '準備在前方補錄' });
    fireEvent.click(screen.getByRole('button', { name: '準備在前方補錄' }));

    expect(await screen.findByText('https://persisted.example')).toBeTruthy();
    expect(browserApi.sendMessage).toHaveBeenCalledWith({
      type: 'PREFLIGHT_INSERTION_SOURCE_PERMISSION',
      sessionId: 'guide-1',
      anchorEntryId: 'entry-1',
    });
    expect(browserApi.requestPermission).not.toHaveBeenCalled();
    expect(editorSave.flushAll).not.toHaveBeenCalled();
    expect(rendered.stepStageProps.editingDisabled).toBe(true);
    expect(rendered.stepRailProps.reorderDisabled).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: '允許並開始' }));

    await waitFor(() => expect(browserApi.requestPermission).toHaveBeenCalledWith({
      origins: ['https://persisted.example/*'],
    }));
    await waitFor(() => expect(browserApi.sendMessage).toHaveBeenCalledWith({
      type: 'START_INSERTION_RECORDING',
      sessionId: 'guide-1',
      anchorEntryId: 'entry-1',
      side: 'before',
      mode: 'steps',
      numbered: false,
    }));
    expect(editorSave.flushAll).toHaveBeenCalledOnce();
    expect(browserApi.requestPermission.mock.invocationCallOrder[0]).toBeLessThan(
      editorSave.flushAll.mock.invocationCallOrder[0],
    );
  });

  it('clears prepared permission when the user changes selection', async () => {
    browserApi.sendMessage.mockResolvedValue({
      ok: true,
      sourceUrl: 'https://persisted.example/path',
      sourceOrigin: 'https://persisted.example',
      permissionPattern: 'https://persisted.example/*',
    });
    render(<EditorApp />);

    fireEvent.click(await screen.findByRole('button', { name: '準備在前方補錄' }));
    expect(await screen.findByText('https://persisted.example')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Ctrl 選取 entry-2' }));

    await waitFor(() => expect(screen.queryByText('https://persisted.example')).toBeNull());
    expect(screen.getByTestId('rail-selected').textContent).toBe('entry-1,entry-2');
    expect(browserApi.requestPermission).not.toHaveBeenCalled();
  });

  it('preflights recapture without trusting the step URL and starts only after confirmation', async () => {
    browserApi.sendMessage.mockImplementation(async (message: any) => {
      if (message.type === 'PREFLIGHT_STEP_RECAPTURE_SOURCE_PERMISSION') {
        return {
          ok: true,
          sourceUrl: 'https://fresh.example/recapture',
          sourceOrigin: 'https://fresh.example',
          permissionPattern: 'https://fresh.example/*',
        };
      }
      if (message.type === 'START_STEP_RECAPTURE') return { ok: true, runId: 'recapture-1' };
      return { ok: true };
    });
    render(<EditorApp />);

    await screen.findByRole('button', { name: '準備補拍' });
    await rendered.stepRailProps.onSelect('entry-2', { additive: false, range: false });
    await waitFor(() => expect(
      screen.getByLabelText('StepStage test double').getAttribute('data-entry-id'),
    ).toBe('entry-2'));
    fireEvent.click(screen.getByRole('button', { name: '準備補拍' }));

    expect(await screen.findByText('https://fresh.example')).toBeTruthy();
    expect(browserApi.requestPermission).not.toHaveBeenCalled();
    expect(browserApi.sendMessage).toHaveBeenCalledWith({
      type: 'PREFLIGHT_STEP_RECAPTURE_SOURCE_PERMISSION',
      sessionId: 'guide-1',
      target: { kind: 'single', stepId: 'entry-2' },
    });

    fireEvent.click(screen.getByRole('button', { name: '允許並開始' }));
    await waitFor(() => expect(browserApi.sendMessage).toHaveBeenCalledWith({
      type: 'START_STEP_RECAPTURE',
      sessionId: 'guide-1',
      target: { kind: 'single', stepId: 'entry-2' },
    }));
    expect(browserApi.requestPermission).toHaveBeenCalledWith({ origins: ['https://fresh.example/*'] });
  });

  it('shows the safe missing-id error and never falls back to a global Guide without a sessionId URL', async () => {
    window.history.replaceState({}, '', '/editor.html');
    render(<EditorApp />);

    expect(await screen.findByRole('heading', { name: '找不到這份教學' })).toBeTruthy();
    expect(screen.getByText(/編輯器網址缺少教學識別碼/)).toBeTruthy();
    expect(recordingSession.useRecordingSession).toHaveBeenCalledWith(null);
    expect(recordingSession.useRecordingSession).not.toHaveBeenCalledWith(undefined);
    expect(database.getGuide).not.toHaveBeenCalled();
    expect(screen.queryByLabelText('StepRail test double')).toBeNull();
  });
});
