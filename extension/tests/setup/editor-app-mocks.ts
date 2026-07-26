import { vi } from 'vitest';

/**
 * Shared mock tables for the EditorApp integration suites
 * (EditorAppStructure / editor-section-undo). vi.mock factories must stay
 * file-local (vitest hoists them per test file), so each suite wires its own
 * factories to tables produced here:
 *
 *   const database = await vi.hoisted(async () =>
 *     (await import('../setup/editor-app-mocks')).makeEditorDatabaseMocks());
 *
 * The tables are supersets; suites use the slice they care about.
 */
export function makeEditorDatabaseMocks() {
  class GuideContentConflictError extends Error {}

  const entryId = (entry: any) => (entry.kind === 'single' ? entry.step.id : entry.anchor.id);

  return {
    GuideContentConflictError,
    UNTITLED_GUIDE_BASE: '未命名教學',
    addGuideSectionAtomically: vi.fn(),
    buildStepEntries: vi.fn((steps: any[]) => steps),
    deleteGuideAnnotationAtomically: vi.fn(),
    deleteGuideEntriesAtomically: vi.fn(),
    deleteGuideSectionAtomically: vi.fn(),
    deleteStepsAndReorder: vi.fn(),
    entryId,
    flattenEntries: vi.fn((entries: any[]) => entries.flatMap((entry) => (
      entry.kind === 'single' ? [entry.step] : [entry.anchor, ...entry.annotations]
    ))),
    getGuide: vi.fn(),
    getGuideStructureSnapshot: vi.fn(),
    getSteps: vi.fn(),
    renameGuideSectionAtomically: vi.fn(),
    reorderGuideAnnotationsAtomically: vi.fn(),
    reorderGuideEntriesAtomically: vi.fn(),
    reorderSteps: vi.fn(),
    restoreGuideAnnotationAtomically: vi.fn(),
    restoreGuideEntriesAtomically: vi.fn(),
    restoreStepsAndReorder: vi.fn(),
    setGuideEntriesNumberedAtomically: vi.fn(),
    updateGuide: vi.fn(),
    updateStepsAtomically: vi.fn(),
  };
}

export type EditorDatabaseMocks = ReturnType<typeof makeEditorDatabaseMocks>;

/** Mock table for @/lib/recording/use-recording-session in editor suites. */
export function makeRecordingSessionMocks() {
  return {
    useRecordingSession: vi.fn(),
    refresh: vi.fn(),
  };
}
