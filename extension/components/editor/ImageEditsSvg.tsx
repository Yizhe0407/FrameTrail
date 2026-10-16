import { memo, useMemo } from 'react';
import type { ImageEdit, StepMarkerEdit, TextEdit } from '@/lib/storage/image-edit-model';
import {
  arrowShape,
  EDIT_SHADOW,
  IMAGE_EDIT_FONT_FAMILY,
  IMAGE_EDIT_FONT_WEIGHT,
  markerGeometry,
  placeText,
  rectCornerRadius,
  TINT_ALPHA,
  withAlpha,
} from '@/lib/media/image-edit-render';

/** The same soft shadow the exported raster paints under every mark. */
const SHADOW_FILTER = `drop-shadow(0 ${EDIT_SHADOW.offsetY}px ${EDIT_SHADOW.blur}px ${EDIT_SHADOW.color})`;

const TextShape = memo(function TextShape({ edit }: { edit: TextEdit }) {
  const placement = useMemo(() => placeText(edit), [edit]);
  return (
    <g style={{ filter: SHADOW_FILTER }}>
      <g
        fill={edit.color}
        fontFamily={IMAGE_EDIT_FONT_FAMILY}
        fontWeight={IMAGE_EDIT_FONT_WEIGHT}
        fontSize={edit.fontSize}
        stroke={placement.outlineWidth === null ? undefined : placement.outlineColor}
        strokeWidth={placement.outlineWidth ?? undefined}
        strokeLinejoin="round"
        paintOrder="stroke"
        style={{ whiteSpace: 'pre' }}
      >
        {placement.lines.map((line, index) => (
          <text key={index} x={placement.x} y={line.baselineY}>{line.text}</text>
        ))}
      </g>
    </g>
  );
});

const MarkerShape = memo(function MarkerShape({ edit }: { edit: StepMarkerEdit }) {
  const geometry = markerGeometry(edit);
  return (
    <g style={{ filter: SHADOW_FILTER }}>
      <circle cx={edit.center.x} cy={edit.center.y} r={edit.radius} fill={geometry.ringColor} />
      <circle cx={edit.center.x} cy={edit.center.y} r={geometry.innerRadius} fill={edit.color} />
      <text
        x={edit.center.x}
        y={geometry.baselineY}
        textAnchor="middle"
        fill={geometry.digitColor}
        fontFamily={IMAGE_EDIT_FONT_FAMILY}
        fontWeight={700}
        fontSize={geometry.fontSize}
      >
        {edit.number}
      </text>
    </g>
  );
});

function Shape({ edit }: { edit: ImageEdit }) {
  switch (edit.kind) {
    case 'rect': {
      const radius = rectCornerRadius(edit.bounds);
      return (
        <rect
          x={edit.bounds.x}
          y={edit.bounds.y}
          width={edit.bounds.width}
          height={edit.bounds.height}
          rx={radius}
          ry={radius}
          fill={edit.fill === 'tint' ? withAlpha(edit.color, TINT_ALPHA) : 'none'}
          stroke={edit.color}
          strokeWidth={edit.width}
          strokeLinejoin="round"
          style={{ filter: SHADOW_FILTER }}
        />
      );
    }
    case 'ellipse':
      return (
        <ellipse
          cx={edit.bounds.x + edit.bounds.width / 2}
          cy={edit.bounds.y + edit.bounds.height / 2}
          rx={edit.bounds.width / 2}
          ry={edit.bounds.height / 2}
          fill={edit.fill === 'tint' ? withAlpha(edit.color, TINT_ALPHA) : 'none'}
          stroke={edit.color}
          strokeWidth={edit.width}
          style={{ filter: SHADOW_FILTER }}
        />
      );
    case 'arrow': {
      const shape = arrowShape(edit);
      if (!shape) return null;
      return (
        <g style={{ filter: SHADOW_FILTER }}>
          <line
            x1={edit.from.x}
            y1={edit.from.y}
            x2={shape.shaftEnd.x}
            y2={shape.shaftEnd.y}
            stroke={edit.color}
            strokeWidth={edit.width}
            strokeLinecap="round"
          />
          <polygon points={shape.head.map((point) => `${point.x},${point.y}`).join(' ')} fill={edit.color} />
        </g>
      );
    }
    case 'step':
      return <MarkerShape edit={edit} />;
    case 'text':
      return <TextShape edit={edit} />;
  }
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
