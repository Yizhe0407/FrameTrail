/**
 * Stable pastel fill for a guide tag. The hue is derived from the tag text, so
 * the same tag wears the same colour in the library, the editor and the tag
 * dialog without storing anything.
 */
const TAG_HUE_CLASSES = ['bg-sora', 'bg-tamago', 'bg-sakura', 'bg-matcha'] as const;

export function tagHueClass(tag: string): (typeof TAG_HUE_CLASSES)[number] {
  let hash = 0;
  for (const char of tag) hash = (hash * 31 + char.codePointAt(0)!) >>> 0;
  return TAG_HUE_CLASSES[hash % TAG_HUE_CLASSES.length];
}
