import type { Bounds } from '../storage/models';

export const HIGHLIGHT_PADDING = 6;
export const HIGHLIGHT_RADIUS = 6;
export const HIGHLIGHT_LINE_WIDTH = 2;
export const HIGHLIGHT_COLOR = '#ff4747';
export const HIGHLIGHT_FILL_COLOR = 'rgba(255, 71, 71, 0.055)';
export const HIGHLIGHT_PREVIEW_FILL_COLOR = 'rgba(255, 71, 71, 0.09)';
export const REDACTION_EXPANSION = 2;
export const REDACTION_COLOR = '#000000';
export const BADGE_RADIUS = 11;
/** Center-to-center distance between adjacent lane badges. Lane-capacity math
 * and the callout candidate grid both assume this exact value. */
export const CALLOUT_SPACING = BADGE_RADIUS * 2 + 6;
export const BADGE_FONT_RATIO = 0.55;
export const BADGE_TEXT_COLOR = '#ffffff';
export const BADGE_FONT_FAMILY =
  'ui-sans-serif, system-ui, sans-serif, "Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol", "Noto Color Emoji"';
export const LEADER_LINE_WIDTH = 1.5;
export const MARKER_RADIUS = 6;
export const MARKER_RING_WIDTH = 2;
export const MARKER_INNER_RADIUS = MARKER_RADIUS * 0.4;

export interface AnnotationPoint {
  x: number;
  y: number;
}

export interface Annotation {
  bounds: Bounds;
  /** 1-based order number shown in the badge when numbered=true. */
  order: number;
}

export interface AnnotationLayout {
  order: number;
  frame: Bounds;
  anchor: AnnotationPoint;
  markerOnly: boolean;
  badgeAnchor: AnnotationPoint;
  callout: AnnotationPoint | null;
  leader: AnnotationPoint[];
}
