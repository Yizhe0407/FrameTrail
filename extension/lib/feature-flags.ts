/**
 * Compile-time feature flags. UX_PLAN §19 asks that higher-risk work ship
 * behind a flag so it can be rolled back without reverting shared plumbing.
 * There is no settings UI yet, so these are static constants; flip a value to
 * disable the feature everywhere it is read.
 */
export const featureFlags = {
  /**
   * Snapshot-mode keyboard candidate traversal (§9.5). The plan's highest-risk
   * item — full acceptance still needs manual screen-reader passes — so it is
   * isolated here rather than always-on.
   */
  snapshotKeyboardNav: true,
} as const;
