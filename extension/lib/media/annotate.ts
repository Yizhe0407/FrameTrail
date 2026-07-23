/**
 * Public annotation API. Layout and raster composition stay in separate modules
 * so browser preview geometry and export rendering can evolve independently.
 */
export {
  BADGE_FONT_FAMILY,
  BADGE_FONT_RATIO,
  BADGE_RADIUS,
  BADGE_TEXT_COLOR,
  HIGHLIGHT_COLOR,
  HIGHLIGHT_FILL_COLOR,
  HIGHLIGHT_LINE_WIDTH,
  HIGHLIGHT_PADDING,
  HIGHLIGHT_PREVIEW_FILL_COLOR,
  HIGHLIGHT_RADIUS,
  LEADER_LINE_WIDTH,
  MARKER_INNER_RADIUS,
  MARKER_RADIUS,
  MARKER_RING_WIDTH,
  REDACTION_COLOR,
  REDACTION_EXPANSION,
  fitHighlightFrame,
  getBadgeFontSize,
  layoutAnnotations,
  type Annotation,
  type AnnotationLayout,
  type AnnotationPoint,
} from './annotation-layout';
export {
  compositeHighlight,
  compositeMultiHighlight,
  getExpandedRedactionBounds,
} from './annotation-composite';
