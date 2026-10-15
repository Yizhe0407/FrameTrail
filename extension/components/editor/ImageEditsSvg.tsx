import { memo, useMemo } from 'react';
import type { ImageEdit, TextEdit } from '@/lib/storage/image-edit-model';
import {
  arrowShape,
  IMAGE_EDIT_COLOR_HEX,
  IMAGE_EDIT_FONT_FAMILY,
  IMAGE_EDIT_FONT_WEIGHT,
  placeText,
} from '@/lib/media/image-edit-render';

const TextShape = memo(function TextShape({ edit }: { edit: TextEdit }) {
  const placement = useMemo(() => placeText(edit), [edit]);
  return (
    <g
      fill={IMAGE_EDIT_COLOR_HEX[edit.color]}
      fontFamily={IMAGE_EDIT_FONT_FAMILY}
      fontWeight={IMAGE_EDIT_FONT_WEIGHT}
      fontSize={edit.fontSize}
      style={{ whiteSpace: 'pre' }}
    >
      {placement.lines.map((line, index) => (
        <text key={index} x={placement.x} y={line.baselineY}>{line.text}</text>
      ))}
    </g>
  );
});

function Shape({ edit }: { edit: ImageEdit }) {
  const color = IMAGE_EDIT_COLOR_HEX[edit.color];
  if (edit.kind === 'rect') {
    return (
      <rect
        x={edit.bounds.x}
        y={edit.bounds.y}
        width={edit.bounds.width}
        height={edit.bounds.height}
        fill="none"
        stroke={color}
        strokeWidth={edit.width}
        strokeLinejoin="round"
      />
    );
  }
  if (edit.kind === 'arrow') {
    const shape = arrowShape(edit);
    if (!shape) return null;
    return (
      <g>
        <line
          x1={edit.from.x}
          y1={edit.from.y}
          x2={shape.shaftEnd.x}
          y2={shape.shaftEnd.y}
          stroke={color}
          strokeWidth={edit.width}
          strokeLinecap="round"
        />
        <polygon points={shape.head.map((point) => `${point.x},${point.y}`).join(' ')} fill={color} />
      </g>
    );
  }
  return <TextShape edit={edit} />;
}

interface Props {
  edits: readonly ImageEdit[];
  /** The screenshot's size in CSS pixels: the coordinate space of every edit. */
  width: number;
  height: number;
}

/** Draws image edits as vector shapes in screenshot coordinates. It scales with
 * the box it fills, so it stays aligned with the pixels at any size, and it
 * draws exactly what the exported raster draws (see image-edit-render). */
export default function ImageEditsSvg({ edits, width, height }: Props) {
  return (
    <svg className="size-full" viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" aria-hidden="true">
      {edits.map((edit) => <Shape key={edit.id} edit={edit} />)}
    </svg>
  );
}
