import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { updateStep, type Step } from '../storage/db';
import {
  clearCommittedDescriptionDraft,
  clearMatchingCommittedDescriptionDrafts,
  discardDescriptionDraft,
  getDescriptionDraftWriterId,
  readDescriptionDrafts,
  writeDescriptionDraft,
  type RestoredDescriptionDraft,
} from './editor-draft-journal';

type SaveCallback = () => Promise<void>;

interface EditorSaveRegistry {
  register: (id: string, save: SaveCallback) => () => void;
  flushAll: () => Promise<void>;
}

const EditorSaveContext = createContext<EditorSaveRegistry | null>(null);

export function EditorSaveProvider({ children }: { children: ReactNode }) {
  const saves = useRef(new Map<string, SaveCallback>());

  const register = useCallback((id: string, save: SaveCallback) => {
    saves.current.set(id, save);
    return () => {
      if (saves.current.get(id) === save) saves.current.delete(id);
    };
  }, []);

  const flushAll = useCallback(async () => {
    await Promise.all([...saves.current.values()].map((save) => save()));
  }, []);

  useEffect(() => {
    // This is only a best-effort fast path. The synchronous localStorage draft
    // journal is the durable close/reload guarantee because browsers may abort
    // IndexedDB work after pagehide.
    const flushBeforeLeaving = () => {
      void flushAll().catch((error) => {
        if (!(error instanceof DraftConfirmationRequiredError)) {
          console.error('離開編輯器前儲存說明失敗', error);
        }
      });
    };
    window.addEventListener('pagehide', flushBeforeLeaving);
    return () => window.removeEventListener('pagehide', flushBeforeLeaving);
  }, [flushAll]);

  return <EditorSaveContext.Provider value={{ register, flushAll }}>{children}</EditorSaveContext.Provider>;
}

export function useEditorSaveRegistry(): EditorSaveRegistry {
  const registry = useContext(EditorSaveContext);
  if (!registry) throw new Error('useEditorSaveRegistry must be used inside EditorSaveProvider.');
  return registry;
}

export type DescriptionSaveStatus = 'saved' | 'dirty' | 'saving' | 'error';

export interface DescriptionAutosaveResult {
  description: string;
  setDescription: (description: string) => void;
  status: DescriptionSaveStatus;
  error: string | null;
  recoveries: RestoredDescriptionDraft[];
  restoreRecovery: (writerId: string) => void;
  discardRecovery: (writerId: string) => void;
  flush: () => Promise<void>;
  retry: () => Promise<void>;
}

const CONFLICT_ERROR = '偵測到較新的已儲存內容；已保留本機草稿，請確認後按重試以覆寫。';
const RECOVERY_CONFIRM_ERROR = '已載入其他分頁的草稿；請確認內容後按重試才會覆寫已儲存內容。';

class DraftConfirmationRequiredError extends Error {
  constructor() {
    super('Draft confirmation is required before overwriting the persisted description.');
    this.name = 'DraftConfirmationRequiredError';
  }
}

/** Keeps the draft editable while writes are pending and serializes updates so
 * an older response can never replace text entered during the request. Every
 * change is first journaled synchronously, so closing the editor cannot create
 * an IndexedDB-unload data-loss window. Concurrent tabs use separate writers;
 * foreign drafts require an explicit load and confirmation. */
export function useStepDescriptionAutosave(
  step: Step,
  onChange: () => void | Promise<void>,
  delay = 650,
): DescriptionAutosaveResult {
  const { register } = useEditorSaveRegistry();
  const writerId = useRef(getDescriptionDraftWriterId());
  const initialCandidates = useRef(readDescriptionDrafts(step, writerId.current));
  const restored = useRef(initialCandidates.current.find((candidate) => candidate.belongsToCurrentWriter) ?? null);
  const initialDescription = restored.current?.description ?? step.description;
  const [description, setDescriptionState] = useState(initialDescription);
  const [status, setStatus] = useState<DescriptionSaveStatus>(
    restored.current?.conflictsWithPersistedValue ? 'error' : initialDescription === step.description ? 'saved' : 'dirty',
  );
  const [error, setError] = useState<string | null>(
    restored.current?.conflictsWithPersistedValue ? CONFLICT_ERROR : null,
  );
  const [recoveries, setRecoveries] = useState<RestoredDescriptionDraft[]>(
    initialCandidates.current.filter((candidate) => !candidate.belongsToCurrentWriter),
  );
  const draft = useRef(initialDescription);
  const persisted = useRef(step.description);
  const lastExternalValue = useRef(step.description);
  const stepId = useRef(step.id);
  const sessionId = useRef(step.sessionId);
  const onChangeRef = useRef(onChange);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const activeSave = useRef<Promise<void> | null>(null);
  const mounted = useRef(true);
  const confirmationRequired = useRef(Boolean(restored.current?.conflictsWithPersistedValue));

  onChangeRef.current = onChange;

  const clearTimer = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  }, []);

  const refreshRecoveries = useCallback(() => {
    const candidates = readDescriptionDrafts(
      { id: stepId.current, sessionId: sessionId.current, description: persisted.current },
      writerId.current,
    );
    if (mounted.current) setRecoveries(candidates.filter((candidate) => !candidate.belongsToCurrentWriter));
  }, []);

  const performFlush = useCallback(async (confirmed: boolean) => {
    clearTimer();
    if (confirmationRequired.current && !confirmed) {
      if (mounted.current) setStatus('error');
      throw new DraftConfirmationRequiredError();
    }
    if (confirmed) confirmationRequired.current = false;
    if (activeSave.current) return activeSave.current;
    if (draft.current === persisted.current) {
      clearCommittedDescriptionDraft(
        { id: stepId.current, sessionId: sessionId.current },
        writerId.current,
        persisted.current,
      );
      clearMatchingCommittedDescriptionDrafts(
        { id: stepId.current, sessionId: sessionId.current },
        persisted.current,
      );
      refreshRecoveries();
      if (mounted.current) {
        setStatus('saved');
        setError(null);
      }
      return;
    }

    const operation = (async () => {
      try {
        while (draft.current !== persisted.current) {
          const nextDescription = draft.current;
          if (mounted.current) {
            setStatus('saving');
            setError(null);
          }
          await updateStep(stepId.current, { description: nextDescription });
          persisted.current = nextDescription;
          clearCommittedDescriptionDraft(
            { id: stepId.current, sessionId: sessionId.current },
            writerId.current,
            nextDescription,
          );
          clearMatchingCommittedDescriptionDrafts(
            { id: stepId.current, sessionId: sessionId.current },
            nextDescription,
          );
          refreshRecoveries();
          try {
            await onChangeRef.current();
          } catch (refreshError) {
            // The IndexedDB commit is authoritative. A failed UI refresh must not
            // misreport a successfully persisted draft as data loss.
            console.warn('說明已儲存，但重新整理編輯器資料失敗', refreshError);
          }
        }
        if (mounted.current) {
          setStatus('saved');
          setError(null);
        }
      } catch (saveError) {
        if (mounted.current) {
          setStatus('error');
          setError('無法儲存，草稿已保留；請重試。');
        }
        throw saveError;
      }
    })();

    activeSave.current = operation;
    try {
      await operation;
    } finally {
      if (activeSave.current === operation) activeSave.current = null;
    }
  }, [clearTimer, refreshRecoveries]);

  const flush = useCallback(() => performFlush(false), [performFlush]);
  const retry = useCallback(() => performFlush(true), [performFlush]);

  const setDescription = useCallback(
    (nextDescription: string) => {
      const needsConfirmation = confirmationRequired.current;
      const journaled = writeDescriptionDraft(
        {
          id: stepId.current,
          sessionId: sessionId.current,
          description: persisted.current,
        },
        nextDescription,
        writerId.current,
      );
      draft.current = nextDescription;
      setDescriptionState(nextDescription);
      setStatus(
        journaled && !needsConfirmation
          ? (nextDescription === persisted.current ? 'saved' : 'dirty')
          : 'error',
      );
      setError((current) =>
        journaled
          ? (needsConfirmation ? current ?? CONFLICT_ERROR : null)
          : '無法建立緊急草稿備份；請保持頁面開啟並立即重試儲存。',
      );
      clearTimer();
      if (journaled && !needsConfirmation && nextDescription !== persisted.current) {
        timer.current = setTimeout(() => {
          void flush().catch((saveError) => console.error('自動儲存說明失敗', saveError));
        }, delay);
      }
    },
    [clearTimer, delay, flush],
  );

  const restoreRecovery = useCallback((recoveryWriterId: string) => {
    const recovery = recoveries.find((candidate) => candidate.writerId === recoveryWriterId);
    if (!recovery) return;
    clearTimer();
    const journaled = writeDescriptionDraft(
      { id: stepId.current, sessionId: sessionId.current, description: persisted.current },
      recovery.description,
      writerId.current,
    );
    if (!journaled) {
      setStatus('error');
      setError('無法安全載入草稿：緊急備份空間不足或儲存服務不可用。');
      return;
    }
    draft.current = recovery.description;
    setDescriptionState(recovery.description);
    confirmationRequired.current = true;
    setStatus('error');
    setError(RECOVERY_CONFIRM_ERROR);
  }, [clearTimer, recoveries]);

  const discardRecovery = useCallback((recoveryWriterId: string) => {
    discardDescriptionDraft(
      { id: stepId.current, sessionId: sessionId.current },
      recoveryWriterId,
    );
    refreshRecoveries();
  }, [refreshRecoveries]);

  useEffect(() => {
    const previousExternalValue = lastExternalValue.current;
    lastExternalValue.current = step.description;
    stepId.current = step.id;
    sessionId.current = step.sessionId;
    persisted.current = step.description;

    if (draft.current === previousExternalValue || draft.current === step.description) {
      draft.current = step.description;
      setDescriptionState(step.description);
      setStatus('saved');
      setError(null);
      confirmationRequired.current = false;
      clearCommittedDescriptionDraft(step, writerId.current, step.description);
      clearMatchingCommittedDescriptionDrafts(step, step.description);
    } else if (step.description !== previousExternalValue) {
      clearTimer();
      writeDescriptionDraft(step, draft.current, writerId.current);
      confirmationRequired.current = true;
      setStatus('error');
      setError(CONFLICT_ERROR);
    }
    refreshRecoveries();
  }, [clearTimer, refreshRecoveries, step.description, step.id, step.sessionId]);

  useEffect(() => register(`description:${step.id}`, flush), [flush, register, step.id]);

  useEffect(() => {
    const handleStorage = (event: StorageEvent) => {
      if (event.storageArea === localStorage && event.key?.startsWith('frametrail:editor-description-draft:')) {
        refreshRecoveries();
      }
    };
    window.addEventListener('storage', handleStorage);
    return () => window.removeEventListener('storage', handleStorage);
  }, [refreshRecoveries]);

  useEffect(() => {
    mounted.current = true;
    if (draft.current !== persisted.current && !confirmationRequired.current) {
      timer.current = setTimeout(() => {
        void flush().catch((saveError) => console.error('恢復關閉前草稿後儲存失敗', saveError));
      }, delay);
    }
    return () => {
      mounted.current = false;
      clearTimer();
      if (!confirmationRequired.current) {
        void flush().catch((saveError) => console.error('卸載說明欄位前儲存失敗', saveError));
      }
    };
  }, [clearTimer, delay, flush]);

  return {
    description,
    setDescription,
    status,
    error,
    recoveries,
    restoreRecovery,
    discardRecovery,
    flush,
    retry,
  };
}
