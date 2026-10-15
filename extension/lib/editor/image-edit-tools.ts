import { EyeOff, MousePointer2, MoveUpRight, RectangleHorizontal, Type, type LucideIcon } from 'lucide-react';
import { t } from '@/lib/shared/i18n';
import type { ImageEditColor } from '@/lib/storage/image-edit-model';
import {
  boundsFromPoints,
  isUsableItemBounds,
  type ImageCssSize,
  type Point,
} from './image-edit-geometry';
import { fitTextHeight, MIN_ARROW_LENGTH, MIN_TEXT_WIDTH } from './image-edit-item-geometry';
import { newItemId, type ImageEditItem, type ImageEditItemKind } from './image-edit-items';

export type ImageEditToolId = 'select' | 'text' | 'arrow' | 'rect' | 'redact';

/** How new items look: remembered across the session and applied to whatever is drawn next. */
export interface ImageEditStyle {
  color: ImageEditColor;
  strokeWidth: number;
  fontSize: number;
}

export const DEFAULT_IMAGE_EDIT_STYLE: ImageEditStyle = { color: 'red', strokeWidth: 4, fontSize: 24 };

/** Width of a text box made by a plain click instead of a drag. */
const DEFAULT_TEXT_WIDTH = 240;

export interface CreateInput {
  from: Point;
  to: Point;
  size: ImageCssSize;
  style: ImageEditStyle;
}

export interface ImageEditTool {
  id: ImageEditToolId;
  icon: LucideIcon;
  label: () => string;
  hint: () => string;
  /** The item kind a drag on empty image creates; null for the pointer tool. */
  creates: ImageEditItemKind | null;
  /** Builds the item for a finished drag, or null when the gesture was too small to mean anything. */
  create?: (input: CreateInput) => ImageEditItem | null;
  /** Which style controls apply to what this tool draws. */
  styleControls: 'none' | 'stroke' | 'text';
}

function boxFromDrag({ from, to, size }: CreateInput) {
  const bounds = boundsFromPoints(from, to, size);
  return isUsableItemBounds(bounds) ? bounds : null;
}

/** A text box dragged out takes the dragged width; a click makes a default-width box at that spot. */
function textFromDrag(input: CreateInput): ImageEditItem {
  const { from, to, size, style } = input;
  const dragged = boundsFromPoints(from, to, size);
  const width = Math.min(dragged.width >= MIN_TEXT_WIDTH ? dragged.width : DEFAULT_TEXT_WIDTH, size.width);
  const x = dragged.width >= MIN_TEXT_WIDTH ? dragged.x : Math.min(from.x, Math.max(size.width - width, 0));
  const y = dragged.width >= MIN_TEXT_WIDTH ? dragged.y : from.y;
  // Empty until typed: the workspace holds it as a draft and stores it only once it has text.
  return fitTextHeight({
    id: newItemId(),
    kind: 'text',
    bounds: { x, y, width, height: style.fontSize },
    text: '',
    fontSize: style.fontSize,
    color: style.color,
  });
}

/** Order here is the order of the toolbar. Add future tools (crop, ...) to this list. */
export const IMAGE_EDIT_TOOLS: readonly ImageEditTool[] = [
  {
    id: 'select',
    icon: MousePointer2,
    label: () => t().editor.imageEdit.tools.select,
    hint: () => t().editor.imageEdit.hints.select,
    creates: null,
    styleControls: 'none',
  },
  {
    id: 'text',
    icon: Type,
    label: () => t().editor.imageEdit.tools.text,
    hint: () => t().editor.imageEdit.hints.text,
    creates: 'text',
    create: textFromDrag,
    styleControls: 'text',
  },
  {
    id: 'arrow',
    icon: MoveUpRight,
    label: () => t().editor.imageEdit.tools.arrow,
    hint: () => t().editor.imageEdit.hints.arrow,
    creates: 'arrow',
    create: ({ from, to, style }) => (
      Math.hypot(to.x - from.x, to.y - from.y) < MIN_ARROW_LENGTH
        ? null
        : { id: newItemId(), kind: 'arrow', from, to, width: style.strokeWidth, color: style.color }
    ),
    styleControls: 'stroke',
  },
  {
    id: 'rect',
    icon: RectangleHorizontal,
    label: () => t().editor.imageEdit.tools.rect,
    hint: () => t().editor.imageEdit.hints.rect,
    creates: 'rect',
    create: (input) => {
      const bounds = boxFromDrag(input);
      return bounds ? { id: newItemId(), kind: 'rect', bounds, width: input.style.strokeWidth, color: input.style.color } : null;
    },
    styleControls: 'stroke',
  },
  {
    id: 'redact',
    icon: EyeOff,
    label: () => t().editor.imageEdit.tools.redact,
    hint: () => t().editor.imageEdit.hints.redact,
    creates: 'redaction',
    create: (input) => {
      const bounds = boxFromDrag(input);
      return bounds ? { id: newItemId(), kind: 'redaction', bounds } : null;
    },
    styleControls: 'none',
  },
];

export function imageEditTool(id: ImageEditToolId): ImageEditTool {
  return IMAGE_EDIT_TOOLS.find((tool) => tool.id === id) ?? IMAGE_EDIT_TOOLS[0];
}
