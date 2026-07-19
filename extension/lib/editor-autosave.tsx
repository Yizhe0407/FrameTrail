import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { updateStep, type Step } from './db';

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
    const flushBeforeLeaving = () => {
      void flushAll().catch((error) => console.error('離開編輯器前儲存說明失敗', error));
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

interface DescriptionAutosaveResult {
  description: string;
  setDescription: (description: string) => void;
  status: DescriptionSaveStatus;
  error: string | null;
  flush: () => Promise<void>;
}

/** Keeps the draft editable while writes are pending and serializes updates so
 * an older response can never replace text entered during the request. */
export function useStepDescriptionAutosave(
  step: Step,
  onChange: () => void | Promise<void>,
  delay = 650,
): DescriptionAutosaveResult {
  const { register } = useEditorSaveRegistry();
  const [description, setDescriptionState] = useState(step.description);
  const [status, setStatus] = useState<DescriptionSaveStatus>('saved');
  const [error, setError] = useState<string | null>(null);
  const draft = useRef(step.description);
  const persisted = useRef(step.description);
  const lastExternalValue = useRef(step.description);
  const stepId = useRef(step.id);
  const onChangeRef = useRef(onChange);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const activeSave = useRef<Promise<void> | null>(null);
  const mounted = useRef(true);

  onChangeRef.current = onChange;

  const clearTimer = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  }, []);

  const flush = useCallback(async () => {
    clearTimer();
    if (activeSave.current) return activeSave.current;
    if (draft.current === persisted.current) {
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
          await onChangeRef.current();
        }
        if (mounted.current) setStatus('saved');
      } catch (saveError) {
        if (mounted.current) {
          setStatus('error');
          setError('無法儲存，請重試。');
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
  }, [clearTimer]);

  const setDescription = useCallback(
    (nextDescription: string) => {
      draft.current = nextDescription;
      setDescriptionState(nextDescription);
      setStatus(nextDescription === persisted.current ? 'saved' : 'dirty');
      setError(null);
      clearTimer();
      if (nextDescription !== persisted.current) {
        timer.current = setTimeout(() => {
          void flush().catch((saveError) => console.error('自動儲存說明失敗', saveError));
        }, delay);
      }
    },
    [clearTimer, delay, flush],
  );

  useEffect(() => {
    const previousExternalValue = lastExternalValue.current;
    lastExternalValue.current = step.description;
    stepId.current = step.id;
    persisted.current = step.description;

    if (draft.current === previousExternalValue || draft.current === step.description) {
      draft.current = step.description;
      setDescriptionState(step.description);
      setStatus('saved');
      setError(null);
    }
  }, [step.description, step.id]);

  useEffect(() => register(`description:${step.id}`, flush), [flush, register, step.id]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      clearTimer();
      void flush().catch((saveError) => console.error('卸載說明欄位前儲存失敗', saveError));
    };
  }, [clearTimer, flush]);

  return { description, setDescription, status, error, flush };
}
