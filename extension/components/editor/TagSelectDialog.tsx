import { useEffect, useState } from 'react';
import { Plus, X } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/dialog';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import InlineAlert from '@/components/shared/InlineAlert';
import { reportError } from '@/components/shared/report-error';
import { GUIDE_TAG_LIMITS, sanitizeGuideTag } from '@/lib/storage/guide-tag-model';
import { getGuideSummaries } from '@/lib/storage/guide-repository';

interface Props {
  open: boolean;
  selectedTags: readonly string[];
  onOpenChange: (open: boolean) => void;
  /** Applied immediately, matching the inline tag chips behind this dialog. */
  onSave: (tags: string[]) => void | Promise<void>;
}

/**
 * Add-only: removing a tag belongs to the inline chips on the stage behind this
 * dialog, which the user reaches without opening anything. Keeping a second
 * remove button here would mean two independent paths to the same write.
 */
export default function TagSelectDialog({
  open,
  selectedTags,
  onOpenChange,
  onSave,
}: Props) {
  const [customInput, setCustomInput] = useState('');
  const [saveError, setSaveError] = useState<string | null>(null);
  const [usedTags, setUsedTags] = useState<readonly string[]>([]);

  useEffect(() => {
    if (!open) return;
    setCustomInput('');
    setSaveError(null);
    let stale = false;
    // Guide summaries are denormalized rows; the read opens no step cursor and
    // no screenshot Blob, so offering tags the user has actually used before is
    // cheap enough to do on open — and unlike a hardcoded vocabulary it is a
    // real signal about how this library is organised.
    void getGuideSummaries()
      .then((summaries) => {
        if (stale) return;
        setUsedTags([...new Set(summaries.flatMap((summary) => summary.tags))]
          .sort((first, second) => first.localeCompare(second, 'zh-TW')));
      })
      .catch((loadFailure) => {
        // Suggestions are a shortcut, not the feature: free text entry still
        // works, so a failed read must not be reported as a save failure.
        console.warn('[frametrail] failed to read previously used guide tags', loadFailure);
      });
    return () => { stale = true; };
  }, [open]);

  // `selectedTags` stays the only source of truth. The owner persists first and
  // re-renders with the stored value, so a refused or failed write can never
  // leave this dialog showing a tag that was not saved — which a local mirror
  // of the selection did.
  async function addTag(tag: string) {
    if (selectedTags.includes(tag) || selectedTags.length >= GUIDE_TAG_LIMITS.maxTags) return;
    setSaveError(null);
    try {
      await onSave([...selectedTags, tag]);
    } catch (saveFailure) {
      setSaveError(reportError('更新標籤失敗', saveFailure, '標籤儲存失敗，請再試一次。'));
    }
  }

  function handleAddCustom() {
    const nextTag = sanitizeGuideTag(customInput);
    setCustomInput('');
    if (!nextTag) return;
    void addTag(nextTag);
  }

  const limitReached = selectedTags.length >= GUIDE_TAG_LIMITS.maxTags;
  const suggestions = usedTags.filter((tag) => !selectedTags.includes(tag));
  const customTag = sanitizeGuideTag(customInput);
  const canAddCustom = Boolean(customTag) && !selectedTags.includes(customTag) && !limitReached;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent showClose={false} className="app-scrollbar max-h-[calc(100vh-32px)] w-[min(360px,calc(100vw-32px))] overflow-y-auto rounded-md border-border/80 bg-card p-5 shadow-2xl dark:border-white/10">
        <div className="flex flex-col gap-3">
          <div className="flex items-center justify-between gap-3">
            <DialogTitle className="text-xs font-bold text-muted-foreground/70 dark:text-white/50">新增標籤</DialogTitle>
            <button
              type="button"
              onClick={() => onOpenChange(false)}
              aria-label="關閉標籤設定"
              className="flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground dark:text-white/60 dark:hover:bg-white/10 dark:hover:text-white"
            >
              <X className="size-4" />
            </button>
          </div>
          <DialogDescription className="sr-only">新增顯示於作品庫的標籤；要移除標籤，請關閉這個視窗並使用標題列上標籤的移除按鈕。</DialogDescription>

          {saveError && <InlineAlert>{saveError}</InlineAlert>}

          {/* Add custom tag row */}
          <div className="flex items-center gap-2">
            <Input
              type="text"
              value={customInput}
              maxLength={GUIDE_TAG_LIMITS.maxTagLength}
              onChange={(e) => setCustomInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  handleAddCustom();
                }
              }}
              placeholder="輸入後按 Enter"
              aria-label="新增標籤名稱"
              className="min-w-0 flex-1 text-xs md:text-xs"
            />
            <button
              type="button"
              onClick={handleAddCustom}
              disabled={!canAddCustom}
              aria-label="新增標籤"
              className="flex size-9 shrink-0 items-center justify-center rounded-md bg-brand text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-40"
            >
              <Plus className="size-4 stroke-[2.5]" />
            </button>
          </div>

          {limitReached && (
            <p className="text-[11px] text-muted-foreground">
              已達 {GUIDE_TAG_LIMITS.maxTags} 個標籤上限，請先移除再新增。
            </p>
          )}

          {selectedTags.length > 0 && (
            <div className="flex flex-col gap-2">
              <span className="text-[11px] font-semibold text-muted-foreground/70 dark:text-white/50">目前標籤</span>
              {/* Shown, not editable: without it a user could type a tag that is
                  already applied and see the add silently do nothing. */}
              <div className="flex flex-wrap gap-2">
                {selectedTags.map((tag) => (
                  <Badge key={tag} variant="secondary" className="max-w-full select-none">
                    <span className="min-w-0 truncate">{tag}</span>
                  </Badge>
                ))}
              </div>
            </div>
          )}

          {suggestions.length > 0 && !limitReached && (
            <div className="flex flex-col gap-2">
              <span className="text-[11px] font-semibold text-muted-foreground/70 dark:text-white/50">曾經使用過</span>
              <div className="flex flex-wrap gap-2">
                {suggestions.map((tag) => (
                  <Badge key={tag} asChild variant="tagEditableAvailable" className="max-w-full select-none">
                    <button
                      type="button"
                      onClick={() => void addTag(tag)}
                      aria-label={`新增 ${tag} 標籤`}
                      title={tag}
                      className="min-w-0 truncate outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      {tag}
                    </button>
                  </Badge>
                ))}
              </div>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
