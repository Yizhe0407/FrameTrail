import { MousePointer2, Square, type LucideIcon } from 'lucide-react';
import { t } from '@/lib/shared/i18n';
import type { ImageEditItemKind } from './image-edit-items';

export type ImageEditToolId = 'select' | 'redact';

export interface ImageEditTool {
  id: ImageEditToolId;
  icon: LucideIcon;
  label: () => string;
  hint: () => string;
  /** The item kind a drag on empty image creates; null for the pointer tool. */
  creates: ImageEditItemKind | null;
}

/** Order here is the order of the toolbar. Add future tools (text, arrow, ...) to this list. */
export const IMAGE_EDIT_TOOLS: readonly ImageEditTool[] = [
  {
    id: 'select',
    icon: MousePointer2,
    label: () => t().editor.imageEdit.tools.select,
    hint: () => t().editor.imageEdit.hints.select,
    creates: null,
  },
  {
    id: 'redact',
    icon: Square,
    label: () => t().editor.imageEdit.tools.redact,
    hint: () => t().editor.imageEdit.hints.redact,
    creates: 'redaction',
  },
];

export function imageEditTool(id: ImageEditToolId): ImageEditTool {
  return IMAGE_EDIT_TOOLS.find((tool) => tool.id === id) ?? IMAGE_EDIT_TOOLS[0];
}
