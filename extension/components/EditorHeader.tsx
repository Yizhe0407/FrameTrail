import { useEffect, useState } from 'react';
import { AlertCircle, Library, Send } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import ResetButton from './ResetButton';
import type { Step } from '@/lib/db';
import type { ActiveOperation } from '@/lib/messages';
import { Button } from '@/components/ui/button';
import { openLibrary } from '@/lib/navigation';

interface Props {
  operationActive: boolean;
  editingDisabled?: boolean;
  operation?: ActiveOperation;
  steps: Step[];
  sessionId: string | null;
  guideTitle?: string;
  onRenameGuide?: (title: string) => Promise<void>;
  qualityIssueCount?: number;
  onOpenQuality?: () => void;
  onOpenPublish?: () => void;
  onReset?: () => void | Promise<void>;
}

export default function EditorHeader({
  operationActive, editingDisabled = false, operation, steps, sessionId, guideTitle, onRenameGuide, qualityIssueCount = 0, onOpenQuality, onOpenPublish, onReset,
}: Props) {
  const [title, setTitle] = useState(guideTitle ?? '');
  const [titleError, setTitleError] = useState(false);
  const unavailable = operationActive || editingDisabled;

  useEffect(() => setTitle(guideTitle ?? ''), [guideTitle]);

  async function saveTitle() {
    const next = title.trim();
    if (!onRenameGuide || !next || next === guideTitle) {
      setTitle(guideTitle ?? title);
      return;
    }
    setTitleError(false);
    try {
      await onRenameGuide(next);
    } catch {
      setTitleError(true);
      setTitle(guideTitle ?? '');
    }
  }

  return (
    <header className="flex min-h-[60px] shrink-0 items-center justify-between gap-2 border-b border-stone-200 bg-stone-50 px-4 py-2 sm:px-7 dark:border-stone-700 dark:bg-stone-900">
      <div className="flex min-w-0 items-baseline gap-2 sm:gap-3.5">
        <h1
          id="frametrail-editor-title"
          tabIndex={-1}
          className="text-[15px] font-semibold text-stone-800 outline-none focus-visible:ring-2 focus-visible:ring-blue-600 dark:text-stone-100"
        >
          FrameTrail
        </h1>
        {guideTitle !== undefined && (
          <input
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            onBlur={() => void saveTitle()}
            onKeyDown={(event) => {
              if (event.key === 'Enter') event.currentTarget.blur();
              if (event.key === 'Escape') { setTitle(guideTitle); event.currentTarget.blur(); }
            }}
            maxLength={120}
            disabled={unavailable}
            aria-label="教學名稱"
            aria-invalid={titleError}
            title={titleError ? '名稱儲存失敗，請再試一次' : '點擊以重新命名'}
            className="hidden min-w-36 max-w-[36vw] rounded border border-transparent bg-transparent px-2 py-1 text-sm text-stone-600 outline-none hover:border-stone-300 focus:border-stone-300 focus:bg-white focus:ring-2 focus:ring-blue-600 sm:block dark:text-stone-300 dark:hover:border-stone-700 dark:focus:border-stone-700 dark:focus:bg-stone-950"
          />
        )}
        {operationActive && (
          <Badge variant="destructive" className="gap-1.5">
            <span className="size-1.5 animate-pulse rounded-full bg-white" />
            {operation === 'recapture' ? '補拍中' : '錄製中'}
          </Badge>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-1 sm:gap-2">
        <Button variant="ghost" size="icon" aria-label="開啟作品庫" title="作品庫" onClick={() => void openLibrary()}>
          <Library />
        </Button>
        {onOpenQuality && qualityIssueCount > 0 && (
          <Button
            variant="ghost"
            size="sm"
            aria-label={`開啟發佈前檢查，${qualityIssueCount} 項待確認`}
            title="查看發佈前需確認的項目"
            onClick={onOpenQuality}
            disabled={unavailable}
            className="hidden text-amber-800 hover:bg-amber-50 hover:text-amber-900 sm:inline-flex dark:text-amber-300 dark:hover:bg-amber-950/30"
          >
            <AlertCircle />
            發佈前確認 {qualityIssueCount}
          </Button>
        )}
        <ResetButton hasSteps={steps.length > 0} sessionId={sessionId} disabled={unavailable} onReset={onReset} />
        <Button
          variant="default"
          onClick={onOpenPublish}
          disabled={unavailable || steps.length === 0 || !onOpenPublish}
        >
          <Send />發佈
        </Button>
      </div>
    </header>
  );
}
