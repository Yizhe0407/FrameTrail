import { Check, Trash2 } from 'lucide-react';
import { IMAGE_EDIT_TOOLS, imageEditTool, type ImageEditToolId } from '@/lib/editor/image-edit-tools';
import { cn } from '@/lib/shared/utils';
import { t } from '@/lib/shared/i18n';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

interface Props {
  tool: ImageEditToolId;
  onToolChange: (tool: ImageEditToolId) => void;
  hasSelection: boolean;
  onDeleteSelected: () => void;
  itemCount: number;
  onDone: () => void;
  disabled?: boolean;
}

/** Tool picker for the image edit mode. Tools come from the registry, so a new
 * tool appears here without touching this component. */
export default function ImageEditToolbar({
  tool,
  onToolChange,
  hasSelection,
  onDeleteSelected,
  itemCount,
  onDone,
  disabled = false,
}: Props) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-center gap-2">
        <div
          role="toolbar"
          aria-label={t().editor.imageEdit.toolbarLabel}
          className="flex items-center gap-0.5 rounded-md border-2 border-border bg-card p-0.5"
        >
          {IMAGE_EDIT_TOOLS.map((entry) => {
            const Icon = entry.icon;
            const active = entry.id === tool;
            return (
              <Tooltip key={entry.id}>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    aria-pressed={active}
                    aria-label={entry.label()}
                    disabled={disabled}
                    onClick={() => onToolChange(entry.id)}
                    className={cn(
                      'flex h-8 items-center gap-1.5 rounded-sm px-2.5 text-xs font-bold outline-none transition-colors focus-ring disabled:pointer-events-none disabled:opacity-40',
                      active ? 'bg-selected text-on-accent' : 'text-muted-foreground hover:bg-secondary hover:text-foreground',
                    )}
                  >
                    <Icon className="size-4" />
                    {entry.label()}
                  </button>
                </TooltipTrigger>
                <TooltipContent>{entry.hint()}</TooltipContent>
              </Tooltip>
            );
          })}
        </div>
        <button
          type="button"
          onClick={onDeleteSelected}
          disabled={disabled || !hasSelection}
          className="flex h-9 items-center gap-1.5 rounded-md border-2 border-border bg-card px-2.5 text-xs font-bold text-muted-foreground outline-none transition-colors focus-ring hover:bg-danger-soft hover:text-danger disabled:pointer-events-none disabled:opacity-40"
        >
          <Trash2 className="size-4" />
          {t().editor.imageEdit.deleteSelected}
        </button>
        <span className="text-xs text-muted-foreground" aria-live="polite">{t().editor.imageEdit.count(itemCount)}</span>
        <button
          type="button"
          onClick={onDone}
          className="ml-auto flex h-9 items-center gap-1.5 rounded-md border-2 border-border bg-primary px-3 text-xs font-bold text-primary-foreground outline-none transition-colors focus-ring hover:opacity-90"
        >
          <Check className="size-4" />
          {t().editor.imageEdit.done}
        </button>
      </div>
      <p className="text-xs text-muted-foreground">{imageEditTool(tool).hint()}</p>
    </div>
  );
}
