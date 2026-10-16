/**
 * The font stack of every overlay injected into a recorded page.
 *
 * Latin system fonts come first on purpose: Latin text, and punctuation such as the
 * curly apostrophe in "isn’t", must be set by a Latin font. Left to a CJK font
 * (Noto Sans TC, Microsoft JhengHei) those marks are drawn full-width, which
 * pulls English words apart. CJK characters are absent from the Latin fonts,
 * so they still fall through to the CJK ones.
 */
export const OVERLAY_FONT_STACK =
  '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, "Noto Sans TC", "PingFang TC", "Microsoft JhengHei", sans-serif';
