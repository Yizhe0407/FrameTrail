/**
 * Compatibility re-export: the toolbar implementation lives in
 * lib/recording/RecordingToolbar so lib/recording/recording-toolbar-host can
 * host it without an upward lib → components dependency. This path stays for
 * the snapshot-shield entrypoint and existing tests.
 */
export { default, type RecordingToolbarState } from '@/lib/recording/RecordingToolbar';
