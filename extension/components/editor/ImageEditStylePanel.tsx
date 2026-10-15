import { IMAGE_EDIT_COLORS, IMAGE_EDIT_FONT_SIZES, IMAGE_EDIT_STROKE_WIDTHS } from '@/lib/storage/image-edit-model';
import { IMAGE_EDIT_COLOR_HEX } from '@/lib/media/image-edit-render';
import type { ImageEditStyle } from '@/lib/editor/image-edit-tools';
import { cn } from '@/lib/shared/utils';
import { t } from '@/lib/shared/i18n';

interface Props {
  controls: 'stroke' | 'text';
  style: ImageEditStyle;
  onChange: (patch: Partial<ImageEditStyle>) => void;
}

interface CropProps {
  /** The pixel size the image will have after the crop, or null when not cropped. */
  size: { width: number; height: number } | null;
  onClear: () => void;
}

/** What the crop tool offers instead of colours: the resulting size and a way to undo the crop. */
export function ImageEditCropPanel({ size, onClear }: CropProps) {
  const copy = t().editor.imageEdit;
  return (
    <div className="flex flex-wrap items-center gap-3">
      <span className="text-xs font-bold text-foreground tabular-nums">
        {size ? copy.cropSize(size.width, size.height) : copy.noCrop}
      </span>
      <button
        type="button"
        onClick={onClear}
        disabled={!size}
        className="flex h-8 items-center rounded-md border-2 border-border bg-card px-3 text-xs font-bold text-foreground outline-none transition-colors focus-ring hover:bg-secondary disabled:pointer-events-none disabled:opacity-40"
      >
        {copy.clearCrop}
      </button>
    </div>
  );
}

const optionClass =
  'flex h-8 min-w-8 items-center justify-center rounded-sm px-2 text-xs font-bold outline-none transition-colors focus-ring';

/** Colour and size/thickness for what is selected, or for what the active tool draws next. */
export default function ImageEditStylePanel({ controls, style, onChange }: Props) {
  const copy = t().editor.imageEdit;
  const sizes = controls === 'text' ? IMAGE_EDIT_FONT_SIZES : IMAGE_EDIT_STROKE_WIDTHS;
  const labels = controls === 'text' ? copy.fontSizes : copy.strokeWidths;
  const current = controls === 'text' ? style.fontSize : style.strokeWidth;

  return (
    <div className="flex flex-wrap items-center gap-3" role="group" aria-label={copy.styleLabel}>
      <div className="flex items-center gap-1.5" role="radiogroup" aria-label={copy.colorLabel}>
        {IMAGE_EDIT_COLORS.map((color) => (
          <button
            key={color}
            type="button"
            role="radio"
            aria-checked={style.color === color}
            aria-label={copy.colors[color]}
            onClick={() => onChange({ color })}
            className={cn(
              'size-6 rounded-full border-2 outline-none transition-transform focus-ring',
              style.color === color ? 'scale-110 border-foreground' : 'border-border-soft hover:scale-105',
            )}
            style={{ backgroundColor: IMAGE_EDIT_COLOR_HEX[color] }}
          />
        ))}
      </div>
      <div className="flex items-center gap-0.5 rounded-md border-2 border-border bg-card p-0.5" role="radiogroup" aria-label={controls === 'text' ? copy.fontSizeLabel : copy.strokeLabel}>
        {sizes.map((value, index) => (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={current === value}
            onClick={() => onChange(controls === 'text' ? { fontSize: value } : { strokeWidth: value })}
            className={cn(optionClass, current === value ? 'bg-selected text-on-accent' : 'text-muted-foreground hover:bg-secondary hover:text-foreground')}
          >
            {labels[index]}
          </button>
        ))}
      </div>
    </div>
  );
}
