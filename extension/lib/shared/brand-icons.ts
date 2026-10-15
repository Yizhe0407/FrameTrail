/**
 * The extension's raster icons, all derived from the mascot artwork in
 * assets/brand/*.svg. modules/brand-icons.ts renders every entry at build
 * time, so no PNG is ever drawn or committed by hand, and the background
 * reads the same table to swap the toolbar icon while a recording runs.
 */

/** `compact` is the mascot redrawn for 16–32px: no blush or corner dots, heavier strokes. */
export type BrandArt = 'full' | 'compact';

export interface BrandIconSpec {
  /** Output path inside the extension, without a leading slash. */
  file: string;
  size: number;
  art: BrandArt;
  /** Adds the red recording dot over the artwork. */
  recording: boolean;
  /** Transparent margin in output pixels on each side. */
  inset: number;
}

/** Sizes WXT discovers as the manifest's `icons` (icon/<size>.png). */
export const MANIFEST_ICON_SIZES = [16, 32, 48, 96, 128] as const;

/** Sizes the toolbar draws; the only ones the recording variant needs. */
export const ACTION_ICON_SIZES = [16, 32] as const;

/** Below this the full artwork turns to mush, so the compact drawing is used. */
const COMPACT_MAX_SIZE = 32;

/** Chrome Web Store guidance: 96×96 artwork centred in the 128×128 icon. */
const STORE_ICON_SIZE = 128;
const STORE_ICON_INSET = 16;

export function brandIconFile(size: number, recording: boolean): string {
  return recording ? `icon/recording-${size}.png` : `icon/${size}.png`;
}

function spec(size: number, recording: boolean): BrandIconSpec {
  return {
    file: brandIconFile(size, recording),
    size,
    art: size <= COMPACT_MAX_SIZE ? 'compact' : 'full',
    recording,
    inset: size === STORE_ICON_SIZE ? STORE_ICON_INSET : 0,
  };
}

export const BRAND_ICONS: readonly BrandIconSpec[] = [
  ...MANIFEST_ICON_SIZES.map((size) => spec(size, false)),
  ...ACTION_ICON_SIZES.map((size) => spec(size, true)),
];

/** The `path` map for action.setIcon. */
export function actionIconPaths(recording: boolean): Record<string, string> {
  return Object.fromEntries(ACTION_ICON_SIZES.map((size) => [String(size), `/${brandIconFile(size, recording)}`]));
}
