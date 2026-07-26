/** Back/forward-cache lifecycle for an injected recorder.
 *
 * A recorded page that navigates away is frozen in the bfcache with every
 * recorder listener and its keep-alive port intact. Without this hook the
 * browser kills the port (logging "Unchecked runtime.lastError" in the
 * service worker), and a later restore resurrects a zombie recorder that
 * swallows the user's clicks and fires captures into a run that may have
 * moved on — the "step was not captured" spam after pressing Back.
 */

export interface BfcacheLifecycleTarget {
  addEventListener(type: string, listener: (event: Event) => void): void;
  removeEventListener(type: string, listener: (event: Event) => void): void;
}

export interface BfcacheLifecycleOptions {
  target: BfcacheLifecycleTarget;
  /** Hand the keep-alive port back before the document is frozen. */
  suspend(): void;
  /** Re-establish the keep-alive port after a restore. */
  resume(): void;
  /** Re-reads the authoritative recording state; true when this recorder's
   * run is still the live one after the document was restored. */
  isRunCurrent(): Promise<boolean>;
  /** Tears the restored recorder down (idempotent) when its run is over. */
  teardown(): void;
}

/**
 * Installs pagehide/pageshow handling for a recorder and returns its
 * uninstaller. On pagehide the port is closed cleanly; on a restore from the
 * bfcache the recorder revalidates its run before resuming — a stale one
 * tears itself down instead of zombie-ing until the keep-alive rejection cap.
 */
export function installBfcacheLifecycle(options: BfcacheLifecycleOptions): () => void {
  const onPageHide = () => {
    options.suspend();
  };
  const onPageShow = (event: Event) => {
    if (!(event as PageTransitionEvent).persisted) return;
    void options.isRunCurrent().then((current) => {
      if (current) options.resume();
      else options.teardown();
    }).catch(() => {
      // State was unreadable, which says nothing about the run: resume and let
      // the background's keep-alive rejection remain the authoritative backstop.
      options.resume();
    });
  };
  options.target.addEventListener('pagehide', onPageHide);
  options.target.addEventListener('pageshow', onPageShow);
  return () => {
    options.target.removeEventListener('pagehide', onPageHide);
    options.target.removeEventListener('pageshow', onPageShow);
  };
}
