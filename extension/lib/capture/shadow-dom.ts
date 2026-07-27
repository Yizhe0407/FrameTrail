/**
 * Shadow root access that also reaches closed roots.
 *
 * `Element.shadowRoot` is null for `attachShadow({ mode: 'closed' })`, so a
 * hit test that relies on it stops at the host: every control inside a closed
 * component collapses into one unusable annotation box, or is unreachable
 * altogether. Extensions get a privileged accessor for exactly this —
 * `chrome.dom.openOrClosedShadowRoot` (Chrome 88+) and Firefox's
 * `browser.dom.openOrClosedShadowRoot` — which is only exposed to content
 * scripts, never to the page.
 *
 * The accessor is resolved per call rather than cached: this module is shared
 * by unit tests running in plain jsdom, where no extension namespace exists and
 * the open-root fallback is the correct behaviour.
 */

interface ShadowRootDomNamespace {
  openOrClosedShadowRoot?: (element: Element) => ShadowRoot | null;
}

function extensionDomNamespace(): ShadowRootDomNamespace | undefined {
  const scope = globalThis as typeof globalThis & {
    chrome?: { dom?: ShadowRootDomNamespace };
    browser?: { dom?: ShadowRootDomNamespace };
  };
  return scope.chrome?.dom ?? scope.browser?.dom;
}

/** Returns the element's shadow root whatever its mode, or null if it has none. */
export function getOpenOrClosedShadowRoot(element: Element): ShadowRoot | null {
  const openOrClosed = extensionDomNamespace()?.openOrClosedShadowRoot;
  if (openOrClosed) {
    try {
      return openOrClosed(element) ?? null;
    } catch {
      // Some hosts (a detached node, a cross-document adoption) make the
      // accessor throw; the open root is still a valid partial answer.
    }
  }
  return element.shadowRoot;
}
