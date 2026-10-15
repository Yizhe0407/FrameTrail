import { useId, type ReactNode } from 'react';
import { ArrowDownToLine, ArrowUpToLine, Copy, Minus, Plus, Trash2 } from 'lucide-react';
import {
  IMAGE_EDIT_FONT_SIZES,
  IMAGE_EDIT_MARKER_RADII,
  IMAGE_EDIT_PRESET_COLORS,
  IMAGE_EDIT_STROKE_WIDTHS,
  SHAPE_FILLS,
  TEXT_LOOKS,
} from '@/lib/storage/image-edit-model';
import { IMAGE_EDIT_LIMITS } from '@/lib/storage/image-edit-model';
import type { ImageEditStyle, StyleField, StylePatch } from '@/lib/editor/image-edit-style';
import { cn } from '@/lib/shared/utils';
import { t } from '@/lib/shared/i18n';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

interface Props {
  fields: readonly StyleField[];
  style: ImageEditStyle;
  /** Number of the selected marker; only shown for a selected marker. */
  number?: number;
  onChange: (patch: StylePatch) => void;
}

interface CropProps {
  /** The pixel size the image will have after the crop, or null when not cropped. */
  size: { width: number; height: number } | null;
  onClear: () => void;
}

export interface ItemActions {
  onDuplicate?: () => void;
  onBringToFront: () => void;
  onSendToBack: () => void;
  onDelete: () => void;
}

const pillButton =
  'flex h-8 items-center justify-center rounded-sm px-2.5 text-xs font-bold outline-none transition-colors focus-ring';

/** A labelled group of controls in the context bar. */
function Group({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-center gap-2" role="group" aria-label={label}>
      <span className="text-[11px] font-bold tracking-wide text-muted-foreground">{label}</span>
      {children}
    </div>
  );
}

/** A row of mutually exclusive options. */
function Segmented<V extends string | number>({ label, value, options, onSelect }: {
  label: string;
  value: V;
  options: readonly { value: V; content: ReactNode; title: string }[];
  onSelect: (value: V) => void;
}) {
  return (
    <div className="flex items-center gap-0.5 rounded-md border-2 border-border bg-card p-0.5" role="radiogroup" aria-label={label}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={value === option.value}
          aria-label={option.title}
          title={option.title}
          onClick={() => onSelect(option.value)}
          className={cn(
            pillButton,
            value === option.value ? 'bg-selected text-on-accent' : 'text-muted-foreground hover:bg-secondary hover:text-foreground',
          )}
        >
          {option.content}
        </button>
      ))}
    </div>
  );
}

function ColorControl({ color, onChange }: { color: string; onChange: (color: string) => void }) {
  const copy = t().editor.imageEdit;
  const inputId = useId();
  const isPreset = (IMAGE_EDIT_PRESET_COLORS as readonly string[]).includes(color);
  return (
    <div className="flex items-center gap-1.5" role="radiogroup" aria-label={copy.colorLabel}>
      {IMAGE_EDIT_PRESET_COLORS.map((preset) => (
        <button
          key={preset}
          type="button"
          role="radio"
          aria-checked={color === preset}
          aria-label={preset}
          title={preset}
          onClick={() => onChange(preset)}
          className={cn(
            'size-6 rounded-full border-2 outline-none transition-transform focus-ring',
            color === preset ? 'scale-110 border-foreground ring-2 ring-card' : 'border-border-soft hover:scale-105',
          )}
          style={{ backgroundColor: preset }}
        />
      ))}
      <label
        htmlFor={inputId}
        title={copy.customColor}
        className={cn(
          'relative size-6 cursor-pointer overflow-hidden rounded-full border-2 transition-transform focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-focus',
          !isPreset ? 'scale-110 border-foreground ring-2 ring-card' : 'border-border-soft hover:scale-105',
        )}
        style={{ background: isPreset ? 'conic-gradient(#ff4747, #ffc800, #22a559, #2f6fed, #b04bff, #ff4747)' : color }}
      >
        <input
          id={inputId}
          type="color"
          aria-label={copy.customColor}
          value={color}
          onChange={(event) => onChange(event.target.value.toLowerCase())}
          className="absolute inset-0 size-full cursor-pointer opacity-0"
        />
      </label>
    </div>
  );
}

function NumberStepper({ value, onChange }: { value: number; onChange: (value: number) => void }) {
  const copy = t().editor.imageEdit;
  const max = IMAGE_EDIT_LIMITS.maxMarkerNumber;
  return (
    <div className="flex items-center gap-0.5 rounded-md border-2 border-border bg-card p-0.5">
      <button type="button" aria-label={copy.numberDown} disabled={value <= 1} onClick={() => onChange(value - 1)} className={cn(pillButton, 'w-8 px-0 text-muted-foreground hover:bg-secondary disabled:opacity-40')}>
        <Minus className="size-3.5" />
      </button>
      <span className="min-w-8 text-center text-xs font-bold tabular-nums" aria-live="polite">{value}</span>
      <button type="button" aria-label={copy.numberUp} disabled={value >= max} onClick={() => onChange(value + 1)} className={cn(pillButton, 'w-8 px-0 text-muted-foreground hover:bg-secondary disabled:opacity-40')}>
        <Plus className="size-3.5" />
      </button>
    </div>
  );
}

/** The controls for what is selected, or for what the active tool draws next. Which controls appear comes from the field list. */
export default function ImageEditStylePanel({ fields, style, number, onChange }: Props) {
  const copy = t().editor.imageEdit;
  return (
    <div className="flex flex-wrap items-center gap-x-5 gap-y-2" role="group" aria-label={copy.styleLabel}>
      {fields.map((field) => {
        switch (field) {
          case 'color':
            return <ColorControl key={field} color={style.color} onChange={(color) => onChange({ color })} />;
          case 'width':
            return (
              <Group key={field} label={copy.strokeLabel}>
                <Segmented
                  label={copy.strokeLabel}
                  value={style.strokeWidth}
                  onSelect={(strokeWidth) => onChange({ strokeWidth })}
                  options={IMAGE_EDIT_STROKE_WIDTHS.map((value, index) => ({
                    value,
                    title: copy.strokeWidths[index],
                    content: <span className="w-5 rounded-full bg-current" style={{ height: value }} aria-hidden="true" />,
                  }))}
                />
              </Group>
            );
          case 'fontSize':
            return (
              <Group key={field} label={copy.fontSizeLabel}>
                <Segmented
                  label={copy.fontSizeLabel}
                  value={style.fontSize}
                  onSelect={(fontSize) => onChange({ fontSize })}
                  options={IMAGE_EDIT_FONT_SIZES.map((value, index) => ({ value, title: copy.fontSizes[index], content: copy.fontSizes[index] }))}
                />
              </Group>
            );
          case 'look':
            return (
              <Group key={field} label={copy.lookLabel}>
                <Segmented
                  label={copy.lookLabel}
                  value={style.look}
                  onSelect={(look) => onChange({ look })}
                  options={TEXT_LOOKS.map((value) => ({
                    value,
                    title: copy.looks[value],
                    content: <LookSample look={value} color={style.color} />,
                  }))}
                />
              </Group>
            );
          case 'fill':
            return (
              <Group key={field} label={copy.fillLabel}>
                <Segmented
                  label={copy.fillLabel}
                  value={style.fill}
                  onSelect={(fill) => onChange({ fill })}
                  options={SHAPE_FILLS.map((value) => ({
                    value,
                    title: copy.fills[value],
                    content: (
                      <span
                        className="size-4 rounded-[4px] border-2 border-current"
                        style={value === 'tint' ? { backgroundColor: `color-mix(in srgb, ${style.color} 35%, transparent)` } : undefined}
                        aria-hidden="true"
                      />
                    ),
                  }))}
                />
              </Group>
            );
          case 'radius':
            return (
              <Group key={field} label={copy.radiusLabel}>
                <Segmented
                  label={copy.radiusLabel}
                  value={style.markerRadius}
                  onSelect={(markerRadius) => onChange({ markerRadius })}
                  options={IMAGE_EDIT_MARKER_RADII.map((value, index) => ({ value, title: copy.radii[index], content: copy.radii[index] }))}
                />
              </Group>
            );
          case 'number':
            return number === undefined ? null : (
              <Group key={field} label={copy.numberLabel}>
                <NumberStepper value={number} onChange={(next) => onChange({ number: next })} />
              </Group>
            );
        }
      })}
    </div>
  );
}

/** "Aa" drawn the way the look will render it, over a neutral photo-like backing. */
function LookSample({ look, color }: { look: (typeof TEXT_LOOKS)[number]; color: string }) {
  const copy = t().editor.imageEdit;
  const dark = isDark(color);
  const edge = dark ? '#ffffff' : '#111111';
  return (
    <span
      className="rounded-[4px] px-1.5 text-sm leading-6 font-bold"
      style={{
        color,
        backgroundColor: look === 'box' ? edge : 'transparent',
        textShadow: look === 'outline' ? `-1px 0 ${edge}, 1px 0 ${edge}, 0 -1px ${edge}, 0 1px ${edge}` : undefined,
      }}
      aria-hidden="true"
    >
      {copy.lookSample}
    </span>
  );
}

function isDark(hex: string): boolean {
  const value = hex.replace('#', '');
  const [r, g, b] = [0, 2, 4].map((index) => Number.parseInt(value.slice(index, index + 2), 16));
  return 0.299 * r + 0.587 * g + 0.114 * b < 140;
}

/** What the crop tool offers instead of style controls: the resulting size and a way to undo the crop. */
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

/** Duplicate, layer order and delete for the selected item. */
export function ImageEditItemActions({ onDuplicate, onBringToFront, onSendToBack, onDelete }: ItemActions) {
  const copy = t().editor.imageEdit;
  const action = (label: string, onClick: (() => void) | undefined, icon: ReactNode, danger = false) =>
    onClick && (
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            aria-label={label}
            onClick={onClick}
            className={cn(
              'flex size-8 items-center justify-center rounded-sm outline-none transition-colors focus-ring',
              danger ? 'text-muted-foreground hover:bg-danger-soft hover:text-danger' : 'text-muted-foreground hover:bg-secondary hover:text-foreground',
            )}
          >
            {icon}
          </button>
        </TooltipTrigger>
        <TooltipContent>{label}</TooltipContent>
      </Tooltip>
    );
  return (
    <div className="flex items-center gap-0.5 rounded-md border-2 border-border bg-card p-0.5">
      {action(copy.duplicate, onDuplicate, <Copy className="size-4" />)}
      {action(copy.bringToFront, onBringToFront, <ArrowUpToLine className="size-4" />)}
      {action(copy.sendToBack, onSendToBack, <ArrowDownToLine className="size-4" />)}
      {action(copy.deleteSelected, onDelete, <Trash2 className="size-4" />, true)}
    </div>
  );
}
