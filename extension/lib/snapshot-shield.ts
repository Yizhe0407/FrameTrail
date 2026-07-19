import { browser } from 'wxt/browser';
import {
  isSnapshotShieldPortMessage,
  SNAPSHOT_SHIELD_CAPTURE_COMPLETE,
  SNAPSHOT_SHIELD_COMMIT,
  SNAPSHOT_SHIELD_INIT,
  SNAPSHOT_SHIELD_POINTER_DOWN,
  SNAPSHOT_SHIELD_POINTER_MOVE,
  SNAPSHOT_SHIELD_PREVIEW,
  SNAPSHOT_SHIELD_READY,
  type SnapshotShieldCaptureCompleteMessage,
  type SnapshotShieldCommitMessage,
  type SnapshotShieldFrameMessage,
  type SnapshotShieldInitMessage,
  type SnapshotShieldPointerDownMessage,
  type SnapshotShieldPointerMoveMessage,
  type SnapshotShieldPreviewMessage,
  type SnapshotShieldPreviewResult,
  type SnapshotShieldSelection,
} from './snapshot-shield-protocol';

const SHIELD_PAGE = '/snapshot-shield.html';
const SHIELD_READY_TIMEOUT_MS = 4_000;
const SHIELD_BACKDROP_CSS = `
  :host::backdrop {
    background: transparent !important;
    -webkit-backdrop-filter: none !important;
    backdrop-filter: none !important;
    filter: none !important;
    animation: none !important;
    transition: none !important;
    pointer-events: none !important;
  }
`;

export interface SnapshotShield {
  ready: Promise<void>;
  runWithoutShield<T>(callback: () => T): T;
  remove(): void;
}

type PointHandler = (
  point: SnapshotShieldPointerDownMessage,
) => SnapshotShieldSelection | null | void | Promise<SnapshotShieldSelection | null | void>;
type HoverHandler = (
  point: SnapshotShieldPointerMoveMessage,
) => SnapshotShieldPreviewResult | Promise<SnapshotShieldPreviewResult>;

function setImportantStyle(element: HTMLElement, property: string, value: string): void {
  element.style.setProperty(property, value, 'important');
}

function isDialogElement(value: unknown): value is HTMLDialogElement {
  return typeof HTMLDialogElement !== 'undefined' && value instanceof HTMLDialogElement;
}

function isModalDialog(element: Element): element is HTMLDialogElement {
  if (!isDialogElement(element)) return false;
  try {
    return element.matches(':modal');
  } catch {
    return element.open;
  }
}

function findModalAncestor(element: Element | null): HTMLDialogElement | null {
  let current = element;
  while (current) {
    if (isModalDialog(current)) return current;
    if (current.parentElement) {
      current = current.parentElement;
      continue;
    }
    const root = current.getRootNode();
    current = root instanceof ShadowRoot ? root.host : null;
  }
  return null;
}

function getDeepActiveElement(): Element | null {
  let active: Element | null = document.activeElement;
  while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement;
  return active;
}

function getDeepElementFromPoint(clientX: number, clientY: number): Element | null {
  if (typeof document.elementFromPoint !== 'function') return null;
  let root: Document | ShadowRoot = document;
  let target: Element | null = null;
  while (true) {
    const next: Element | null = root.elementFromPoint(clientX, clientY);
    if (!next) return target;
    target = next;
    if (!next.shadowRoot) return target;
    root = next.shadowRoot;
  }
}

function installBackdropStyles(shadowRoot: ShadowRoot): void {
  try {
    if (
      typeof CSSStyleSheet !== 'undefined' &&
      typeof CSSStyleSheet.prototype.replaceSync === 'function' &&
      'adoptedStyleSheets' in shadowRoot
    ) {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(SHIELD_BACKDROP_CSS);
      shadowRoot.adoptedStyleSheets = [...shadowRoot.adoptedStyleSheets, sheet];
      return;
    }
  } catch {
    // Fall through for browsers without constructable stylesheet support.
  }
  const style = document.createElement('style');
  style.textContent = SHIELD_BACKDROP_CSS;
  shadowRoot.append(style);
}

function hardenHost(host: HTMLElement): void {
  const declarations: Record<string, string> = {
    all: 'initial',
    position: 'fixed',
    inset: '0',
    width: '100vw',
    height: '100vh',
    'min-width': '0',
    'min-height': '0',
    'max-width': 'none',
    'max-height': 'none',
    margin: '0',
    padding: '0',
    border: '0',
    display: 'block',
    'box-sizing': 'border-box',
    background: 'transparent',
    opacity: '1',
    visibility: 'visible',
    overflow: 'hidden',
    contain: 'strict',
    transform: 'none',
    filter: 'none',
    'backdrop-filter': 'none',
    animation: 'none',
    transition: 'none',
    'pointer-events': 'auto',
    'z-index': '2147483647',
  };
  for (const [property, value] of Object.entries(declarations)) setImportantStyle(host, property, value);
}

function hardenFrame(frame: HTMLIFrameElement): void {
  const declarations: Record<string, string> = {
    all: 'initial',
    position: 'absolute',
    inset: '0',
    width: '100%',
    height: '100%',
    margin: '0',
    padding: '0',
    border: '0',
    display: 'block',
    'box-sizing': 'border-box',
    opacity: '1',
    visibility: 'visible',
    background: 'transparent',
    'pointer-events': 'auto',
  };
  for (const [property, value] of Object.entries(declarations)) setImportantStyle(frame, property, value);
}

/**
 * Mounts an extension-origin browsing context over the page. Pointer events
 * terminate inside the iframe instead of traversing the host page's window,
 * document, or target listeners.
 */
export function createSnapshotShield(onPoint: PointHandler, onHover?: HoverHandler): SnapshotShield {
  const token = crypto.randomUUID();
  const host = document.createElement('div');
  host.setAttribute('data-frametrail-snapshot-shield', '');
  host.setAttribute('popover', 'manual');
  hardenHost(host);

  const shadowRoot = host.attachShadow({ mode: 'closed' });
  installBackdropStyles(shadowRoot);
  const frame = document.createElement('iframe');
  frame.title = 'FrameTrail snapshot input shield';
  frame.tabIndex = -1;
  frame.referrerPolicy = 'no-referrer';
  hardenFrame(frame);

  const frameUrl = new URL(browser.runtime.getURL(SHIELD_PAGE));
  frameUrl.searchParams.set('token', token);
  frame.src = frameUrl.href;
  shadowRoot.append(frame);

  let removed = false;
  let ready = false;
  let channelGeneration = 0;
  let nextSelectionId = 1;
  const committedSelections: Array<SnapshotShieldSelection & { id: number }> = [];
  let port: MessagePort | null = null;
  let resolveReady!: () => void;
  let rejectReady!: (reason: Error) => void;
  const readyPromise = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });

  const postToFrame = (message: SnapshotShieldFrameMessage): void => {
    if (removed || !port) return;
    try {
      port.postMessage(message);
    } catch (error) {
      console.error('[frametrail] failed to update snapshot shield UI', error);
    }
  };

  const handleHover = async (message: SnapshotShieldPointerMoveMessage, generation: number): Promise<void> => {
    let preview: SnapshotShieldPreviewResult = {
      rect: null,
      candidateOffset: message.candidateOffset,
    };
    try {
      if (onHover) preview = await onHover(message);
    } catch (error) {
      console.error('[frametrail] failed to preview snapshot target', error);
    }
    if (removed || generation !== channelGeneration) return;
    const previewMessage: SnapshotShieldPreviewMessage = {
      type: SNAPSHOT_SHIELD_PREVIEW,
      token,
      requestId: message.requestId,
      rect: preview.rect,
      candidateOffset: preview.candidateOffset,
    };
    postToFrame(previewMessage);
  };

  const handlePoint = async (message: SnapshotShieldPointerDownMessage, generation: number): Promise<void> => {
    let selection: SnapshotShieldSelection | null = null;
    try {
      selection = (await onPoint(message)) ?? null;
    } catch (error) {
      console.error('[frametrail] failed to handle snapshot shield pointer', error);
    }
    if (removed) return;

    const committed = selection ? { ...selection, id: nextSelectionId++ } : null;
    if (committed) committedSelections.push(committed);

    if (generation === channelGeneration) {
      const completeMessage: SnapshotShieldCaptureCompleteMessage = {
        type: SNAPSHOT_SHIELD_CAPTURE_COMPLETE,
        token,
        selection: committed,
      };
      postToFrame(completeMessage);
    } else if (committed) {
      const commitMessage: SnapshotShieldCommitMessage = {
        type: SNAPSHOT_SHIELD_COMMIT,
        token,
        selection: committed,
      };
      postToFrame(commitMessage);
    }
  };

  const runWithoutShieldHitTesting = <T>(callback: () => T): T => {
    if (removed) return callback();
    setImportantStyle(host, 'pointer-events', 'none');
    setImportantStyle(frame, 'pointer-events', 'none');
    try {
      return callback();
    } finally {
      setImportantStyle(frame, 'pointer-events', 'auto');
      setImportantStyle(host, 'pointer-events', 'auto');
    }
  };

  const findMountParent = (): HTMLElement => {
    const activeModal = findModalAncestor(getDeepActiveElement());
    if (activeModal) return activeModal;

    const hitModal = runWithoutShieldHitTesting(() => {
      const points = [
        [window.innerWidth / 2, window.innerHeight / 2],
        [1, 1],
        [Math.max(window.innerWidth - 1, 0), Math.max(window.innerHeight - 1, 0)],
      ] as const;
      for (const [clientX, clientY] of points) {
        const modal = findModalAncestor(getDeepElementFromPoint(clientX, clientY));
        if (modal) return modal;
      }
      return null;
    });
    if (hitModal) return hitModal;

    const modalDialogs = Array.from(document.querySelectorAll('dialog')).filter(isModalDialog);
    return modalDialogs.length === 1 ? modalDialogs[0] : document.documentElement;
  };

  const observer = new MutationObserver((records) => {
    if (removed) return;
    const modalTreeChanged = records.some((record) => {
      if (record.type === 'attributes') return isDialogElement(record.target);
      return [...record.addedNodes, ...record.removedNodes].some(
        (node) =>
          isDialogElement(node) ||
          (node instanceof Element && node.querySelector('dialog') !== null),
      );
    });
    if (!host.isConnected || modalTreeChanged) mountHost();
  });

  const mountHost = () => {
    let parent = findMountParent();
    if (!parent.isConnected) parent = document.documentElement;
    if (host.parentNode !== parent) {
      const hidePopover = (host as HTMLElement & { hidePopover?: () => void }).hidePopover;
      try {
        hidePopover?.call(host);
      } catch {
        // A closed popover throws in some browser versions.
      }
      const moveBefore = (parent as HTMLElement & {
        moveBefore?: (node: Node, child: Node | null) => void;
      }).moveBefore;
      if (host.isConnected && typeof moveBefore === 'function') moveBefore.call(parent, host, null);
      else parent.append(host);
    }
    const showPopover = (host as HTMLElement & { showPopover?: () => void }).showPopover;
    if (typeof showPopover !== 'function') return;
    try {
      if (!host.matches(':popover-open')) showPopover.call(host);
    } catch {
      // Already-open popovers throw in some browser versions.
    }
  };

  const remove = () => {
    if (removed) return;
    removed = true;
    clearTimeout(readyTimeout);
    observer.disconnect();
    port?.close();
    port = null;
    host.remove();
    if (!ready) rejectReady(new Error('Snapshot input shield was removed before it became ready.'));
  };

  const fail = (message: string) => {
    if (removed || ready) return;
    remove();
    console.error(`[frametrail] ${message}`);
  };

  const readyTimeout = setTimeout(
    () => fail('snapshot input shield did not become ready before the startup timeout'),
    SHIELD_READY_TIMEOUT_MS,
  );

  frame.addEventListener(
    'load',
    () => {
      if (removed || !frame.contentWindow) return;
      const generation = ++channelGeneration;
      port?.close();
      const channel = new MessageChannel();
      port = channel.port1;
      port.onmessage = (event) => {
        if (removed || generation !== channelGeneration) return;
        if (!isSnapshotShieldPortMessage(event.data, token)) return;
        if (event.data.type === SNAPSHOT_SHIELD_READY) {
          if (!ready) {
            ready = true;
            clearTimeout(readyTimeout);
            resolveReady();
          }
          for (const selection of committedSelections) {
            const commitMessage: SnapshotShieldCommitMessage = {
              type: SNAPSHOT_SHIELD_COMMIT,
              token,
              selection,
            };
            postToFrame(commitMessage);
          }
          return;
        }
        if (event.data.type === SNAPSHOT_SHIELD_POINTER_MOVE) {
          void handleHover(event.data, generation);
          return;
        }
        if (event.data.type === SNAPSHOT_SHIELD_POINTER_DOWN) {
          void handlePoint(event.data, generation);
        }
      };
      port.onmessageerror = () => fail('snapshot input shield message channel failed');
      port.start();

      const message: SnapshotShieldInitMessage = { type: SNAPSHOT_SHIELD_INIT, token };
      frame.contentWindow.postMessage(message, frameUrl.origin, [channel.port2]);
    },
  );

  frame.addEventListener('error', () => fail('snapshot input shield page failed to load'), { once: true });
  mountHost();
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['open'],
  });

  return {
    ready: readyPromise,
    runWithoutShield: runWithoutShieldHitTesting,
    remove,
  };
}
