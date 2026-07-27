/**
 * The host element every in-page overlay this extension injects is built on.
 *
 * `all: initial` plus per-property `!important` is what keeps page CSS from
 * reaching the overlay: a site that styles `div { position: static }` or hides
 * elements by class must not be able to move or erase the recorder's UI.
 */

const BASE_DECLARATIONS: Record<string, string> = {
  all: 'initial',
  position: 'fixed',
  inset: '0',
  width: '100vw',
  height: '100vh',
  margin: '0',
  padding: '0',
  border: '0',
  display: 'block',
  background: 'transparent',
  'z-index': '2147483647',
};

export function setImportantStyle(element: HTMLElement, property: string, value: string): void {
  element.style.setProperty(property, value, 'important');
}

/**
 * @param popover Whether the host is shown through the top layer. Only pass
 * true for a host that calls `showPopover()`: the attribute hides the element
 * until it does.
 */
export function createViewportOverlayHost(
  attribute: string,
  declarations: Record<string, string> = {},
  { popover = false }: { popover?: boolean } = {},
): HTMLElement {
  const host = document.createElement('div');
  host.setAttribute(attribute, '');
  if (popover) host.setAttribute('popover', 'manual');
  for (const [property, value] of Object.entries({ ...BASE_DECLARATIONS, ...declarations })) {
    setImportantStyle(host, property, value);
  }
  return host;
}
