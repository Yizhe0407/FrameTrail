// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { silenceIntentionalErrorLogs } from '../setup/silence-intentional-logs';

const database = vi.hoisted(() => {
  class GuideContentConflictError extends Error {}

  const entryId = (entry: any) => entry.kind === 'single' ? entry.step.id : entry.anchor.id;

  return {
    GuideContentConflictError,
    addGuideSectionAtomically: vi.fn(),
    deleteGuideAnnotationAtomically: vi.fn(),
    deleteGuideEntriesAtomically: vi.fn(),
    deleteGuideSectionAtomically: vi.fn(),
    entryId,
    getGuide: vi.fn(),
    getGuideStructureSnapshot: vi.fn(),
    renameGuideSectionAtomically: vi.fn(),
    reorderGuideAnnotationsAtomically: vi.fn(),
    reorderGuideEntriesAtomically: vi.fn(),
    restoreGuideAnnotationAtomically: vi.fn(),
    restoreGuideEntriesAtomically: vi.fn(),
    setGuideEntriesNumberedAtomically: vi.fn(),
    updateGuide: vi.fn(),
  };
});

const recordingSession = vi.hoisted(() => ({
  useRecordingSession: vi.fn(),
  refresh: vi.fn(),
}));

vi.mock('wxt/browser', () => ({
  browser: {
    runtime: {
      getURL: vi.fn((path: string) => `chrome-extension://frametrail${path}`),
      sendMessage: vi.fn(),
    },
    permissions: { request: vi.fn() },
  },
}));

vi.mock('@/lib/storage/db', () => database);
vi.mock('@/lib/recording/useRecordingSession', () => ({
  useRecordingSession: recordingSession.useRecordingSession,
}));
vi.mock('@/lib/editor/editor-autosave', () => ({
  EditorSaveProvider: ({ children }: any) => children,
  useEditorSaveRegistry: () => ({ flushAll: vi.fn().mockResolvedValue(undefined) }),
  DraftConfirmationRequiredError: class DraftConfirmationRequiredError extends Error {},
}));
vi.mock('@/lib/export/export-images', () => ({ exportImagesAsZip: vi.fn() }));

vi.mock('@/components/editor/EditorHeader', () => ({ default: () => null }));
vi.mock('@/components/editor/StepRail', () => ({
  default: (props: any) => (
    <aside aria-label="StepRail test double">
      <button type="button" onClick={() => void props.onDeleteSection('section-1')}>
        刪除第一個章節
      </button>
    </aside>
  ),
}));
vi.mock('@/components/editor/StepStage', () => ({ default: () => null }));
vi.mock('@/components/shared/EmptyState', () => ({ default: () => <div>EmptyState</div> }));
vi.mock('@/components/editor/Lightbox', () => ({ default: () => null }));
vi.mock('@/components/editor/PublishGuideDialog', () => ({ default: () => null }));

import EditorApp from '@/entrypoints/editor/App';

const entries = [
  {
    kind: 'single',
    step: {
      id: 'entry-1',
      sessionId: 'guide-1',
      order: 0,
      bounds: null,
      devicePixelRatio: 1,
      description: '第一步',
      url: 'https://example.test/one',
      timestamp: 1,
      screenshotBlob: new Blob(['one'], { type: 'image/png' }),
    },
  },
  {
    kind: 'single',
    step: {
      id: 'entry-2',
      sessionId: 'guide-1',
      order: 1,
      bounds: null,
      devicePixelRatio: 1,
      description: '第二步',
      url: 'https://example.test/two',
      timestamp: 2,
      screenshotBlob: new Blob(['two'], { type: 'image/png' }),
    },
  },
] as any[];

const section = { id: 'section-1', title: '準備', startEntryId: 'entry-1' };

function makeGuide(contentRevision: number, sections: any[]) {
  return {
    id: 'guide-1',
    title: '章節還原測試',
    description: '',
    sections,
    createdAt: 1,
    updatedAt: 2,
    contentRevision,
  };
}

const idleRecording = {
  sessionId: null,
  operation: null,
  isRecording: false,
  recapture: null,
  recaptureResult: null,
  itemCount: 0,
};

beforeEach(() => {
  vi.clearAllMocks();
  recordingSession.refresh.mockResolvedValue(undefined);
  recordingSession.useRecordingSession.mockReturnValue({
    sessionId: 'guide-1',
    tabId: 17,
    steps: entries,
    error: null,
    dataError: null,
    refresh: recordingSession.refresh,
    recording: idleRecording,
  });
  window.history.replaceState({}, '', '/editor.html?sessionId=guide-1');
});

afterEach(() => {
  cleanup();
  window.history.replaceState({}, '', '/');
});

describe('section delete undo', () => {
  it('offers an undo that re-creates the deleted section at its original position', async () => {
    let snapshotSections: any[] = [section];
    let snapshotRevision = 7;
    database.getGuideStructureSnapshot.mockImplementation(async () => ({
      guide: makeGuide(snapshotRevision, snapshotSections),
      entries,
      entryIds: entries.map(database.entryId),
    }));
    database.deleteGuideSectionAtomically.mockImplementation(async () => {
      snapshotSections = [];
      snapshotRevision = 8;
      return { guide: makeGuide(8, []), entryIds: entries.map(database.entryId) };
    });
    database.addGuideSectionAtomically.mockImplementation(async () => {
      snapshotSections = [{ ...section, id: 'section-restored' }];
      snapshotRevision = 9;
      return { guide: makeGuide(9, snapshotSections), entryIds: entries.map(database.entryId) };
    });

    render(<EditorApp />);

    fireEvent.click(await screen.findByRole('button', { name: '刪除第一個章節' }));

    await waitFor(() => expect(database.deleteGuideSectionAtomically).toHaveBeenCalledOnce());
    expect(database.deleteGuideSectionAtomically).toHaveBeenCalledWith('guide-1', 'section-1', 7);

    // The destructive edit must offer the same undo affordance as every other
    // structural mutation.
    expect(await screen.findByText('已刪除章節「準備」')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', {  name: '還原'  }));

    await waitFor(() => expect(database.addGuideSectionAtomically).toHaveBeenCalledOnce());
    // Restore re-creates the section against the post-delete revision, bound
    // to the same start entry and title — i.e. the same display position.
    expect(database.addGuideSectionAtomically).toHaveBeenCalledWith('guide-1', 'entry-1', '準備', 8);

    await waitFor(() => expect(screen.queryByText('已刪除章節「準備」')).toBeNull());
  });

  it('drops the undo instead of restoring over a newer revision', async () => {
    silenceIntentionalErrorLogs();
    let snapshotSections: any[] = [section];
    let snapshotRevision = 7;
    database.getGuideStructureSnapshot.mockImplementation(async () => ({
      guide: makeGuide(snapshotRevision, snapshotSections),
      entries,
      entryIds: entries.map(database.entryId),
    }));
    database.deleteGuideSectionAtomically.mockImplementation(async () => {
      snapshotSections = [];
      snapshotRevision = 8;
      return { guide: makeGuide(8, []), entryIds: entries.map(database.entryId) };
    });

    render(<EditorApp />);

    fireEvent.click(await screen.findByRole('button', { name: '刪除第一個章節' }));
    expect(await screen.findByText('已刪除章節「準備」')).toBeTruthy();

    // Another writer moves the Guide forward before the user clicks 還原.
    snapshotRevision = 12;
    fireEvent.click(screen.getByRole('button', {  name: '還原'  }));

    await waitFor(() => expect(screen.queryByText('已刪除章節「準備」')).toBeNull());
    expect(database.addGuideSectionAtomically).not.toHaveBeenCalled();
    expect(await screen.findByText('內容已在其他操作中變更，因此無法安全還原舊版本。')).toBeTruthy();
  });
});
