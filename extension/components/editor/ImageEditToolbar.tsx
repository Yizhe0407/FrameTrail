import { Check, Loader2, Maximize, Redo2, Trash2, Undo2, ZoomIn, ZoomOut } from 'lucide-react';
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
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
  /** Current zoom relative to the fitted size, 1 = whole image. */
  zoom: number;
  canZoomIn: boolean;
  canZoomOut: boolean;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onZoomFit: () => void;
  saving: boolean;
  onDone: () => void;
  doneDisabled?: boolean;
}

const iconButtonClass =
  'flex size-8 items-center justify-center rounded-sm text-muted-foreground outline-none transition-colors focus-ring hover:bg-secondary hover:text-foreground disabled:pointer-events-none disabled:opacity-40';

function IconButton({ label, onClick, disabled, children }: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button type="button" aria-label={label} onClick={onClick} disabled={disabled} className={iconButtonClass}>
          {children}
        </button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

/** Tool picker, history, zoom and Done for the image edit workspace. Tools come
 * from the registry, so a new tool appears here without touching this file. */
export default function ImageEditToolbar(props: Props) {
  const copy = t().editor.imageEdit;
  const { tool } = props;
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-center gap-2">
        <div role="toolbar" aria-label={copy.toolbarLabel} className="flex items-center gap-0.5 rounded-md border-2 border-border bg-card p-0.5">
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
                    onClick={() => props.onToolChange(entry.id)}
                    className={cn(
                      'flex h-8 items-center gap-1.5 rounded-sm px-2.5 text-xs font-bold outline-none transition-colors focus-ring',
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

        <div className="flex items-center gap-0.5 rounded-md border-2 border-border bg-card p-0.5">
          <IconButton label={copy.undo} onClick={props.onUndo} disabled={!props.canUndo}><Undo2 className="size-4" /></IconButton>
          <IconButton label={copy.redo} onClick={props.onRedo} disabled={!props.canRedo}><Redo2 className="size-4" /></IconButton>
          <IconButton label={copy.deleteSelected} onClick={props.onDeleteSelected} disabled={!props.hasSelection}><Trash2 className="size-4" /></IconButton>
        </div>

        <div className="flex items-center gap-0.5 rounded-md border-2 border-border bg-card p-0.5">
          <IconButton label={copy.zoomOut} onClick={props.onZoomOut} disabled={!props.canZoomOut}><ZoomOut className="size-4" /></IconButton>
          <span className="min-w-12 text-center text-xs font-bold text-foreground tabular-nums" aria-live="polite">
            {copy.zoomLevel(Math.round(props.zoom * 100))}
          </span>
          <IconButton label={copy.zoomIn} onClick={props.onZoomIn} disabled={!props.canZoomIn}><ZoomIn className="size-4" /></IconButton>
          <IconButton label={copy.zoomFit} onClick={props.onZoomFit} disabled={props.zoom === 1}><Maximize className="size-4" /></IconButton>
        </div>

        <span className="text-xs text-muted-foreground" aria-live="polite">{copy.count(props.itemCount)}</span>

        <div className="ml-auto flex items-center gap-3">
          {props.saving && (
            <span className="flex items-center gap-1.5 text-xs text-muted-foreground" role="status">
              <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />{copy.saving}
            </span>
          )}
          <button
            type="button"
            onClick={props.onDone}
            disabled={props.doneDisabled}
            className="flex h-9 items-center gap-1.5 rounded-md border-2 border-border bg-primary px-3 text-xs font-bold text-primary-foreground outline-none transition-colors focus-ring hover:opacity-90 disabled:opacity-50"
          >
            <Check className="size-4" />
            {copy.done}
          </button>
        </div>
      </div>
      <p className="text-xs text-muted-foreground">{imageEditTool(tool).hint()} {copy.hints.navigate}</p>
    </div>
  );
}
