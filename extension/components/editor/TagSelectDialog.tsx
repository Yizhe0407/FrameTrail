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

const PRESET_TAGS = ['入門', '團隊', '專案', '整合', '報表', '行動', '教學', '設定'];

interface Props {
  open: boolean;
  selectedTags: readonly string[];
  onOpenChange: (open: boolean) => void;
  /** Applied immediately, matching the inline tag chips behind this dialog. */
  onSave: (tags: string[]) => void | Promise<void>;
}

export default function TagSelectDialog({
  open,
  selectedTags,
  onOpenChange,
  onSave,
}: Props) {
  const [customInput, setCustomInput] = useState('');
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setCustomInput('');
    setSaveError(null);
  }, [open]);

  // `selectedTags` stays the only source of truth. The owner persists first and
  // re-renders with the stored value, so a refused or failed write can never
  // leave this dialog showing a tag that was not saved — which a local mirror
  // of the selection did.
  async function apply(tags: string[]) {
    setSaveError(null);
    try {
      await onSave(tags);
    } catch (saveFailure) {
      setSaveError(reportError('更新標籤失敗', saveFailure, '標籤儲存失敗，請再試一次。'));
    }
  }

  function toggleTag(tag: string) {
    if (selectedTags.includes(tag)) {
      void apply(selectedTags.filter((selected) => selected !== tag));
      return;
    }
    if (selectedTags.length >= GUIDE_TAG_LIMITS.maxTags) return;
    void apply([...selectedTags, tag]);
  }

  function handleAddCustom() {
    const nextTag = sanitizeGuideTag(customInput);
    setCustomInput('');
    if (!nextTag || selectedTags.includes(nextTag) || selectedTags.length >= GUIDE_TAG_LIMITS.maxTags) return;
    void apply([...selectedTags, nextTag]);
  }

  const allAvailable = Array.from(new Set([...PRESET_TAGS, ...selectedTags]));
  const customTag = sanitizeGuideTag(customInput);
  const canAddCustom = Boolean(customTag) && !selectedTags.includes(customTag) && selectedTags.length < GUIDE_TAG_LIMITS.maxTags;

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
          <DialogDescription className="sr-only">新增、移除或設定顯示於作品庫的標籤。</DialogDescription>

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

          <div className="my-1 border-t border-border/80 dark:border-white/8" />

          {/* Tags Pills list */}
          <div className="flex flex-wrap gap-2 pt-1">
            {allAvailable.map((tag) => {
              const isSelected = selectedTags.includes(tag);
              const selectionLimitReached = !isSelected && selectedTags.length >= GUIDE_TAG_LIMITS.maxTags;
              return (
                <Badge
                  key={tag}
                  variant={isSelected ? 'tagEditable' : 'tagEditableAvailable'}
                  className="max-w-full select-none"
                >
                  <button
                    type="button"
                    onClick={() => toggleTag(tag)}
                    disabled={selectionLimitReached}
                    className="min-w-0 truncate rounded-sm outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {tag}
                  </button>
                  {isSelected && (
                    <button
                      type="button"
                      onClick={() => toggleTag(tag)}
                      aria-label={`移除 ${tag} 標籤`}
                      className="flex size-4 items-center justify-center rounded-full bg-foreground/10 text-foreground/70 transition-colors hover:bg-destructive/20 hover:text-destructive dark:bg-white/15 dark:text-white/70 dark:hover:bg-rose-500/30 dark:hover:text-rose-300"
                    >
                      <X className="size-2.5 stroke-[2.5]" />
                    </button>
                  )}
                </Badge>
              );
            })}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
