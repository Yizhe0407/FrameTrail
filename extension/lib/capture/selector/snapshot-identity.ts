/** Stable within one immutable snapshot document, including when a framework
 * replaces an element node with an equivalent node at the same DOM path. */
export function buildSnapshotTargetIdentity(el: Element): string {
  const parts: string[] = [];
  let node: Element | null = el;

  while (node) {
    const parent: Element | null = node.parentElement;
    const siblings = parent ? Array.from(parent.children).filter((s) => s.tagName === node!.tagName) : [node];
    const index = siblings.indexOf(node) + 1;
    parts.unshift(`${node.tagName.toLowerCase()}[${index}]${node.id ? `#${node.id}` : ''}`);
    if (parent) {
      node = parent;
      continue;
    }
    const root = node.getRootNode();
    if (root instanceof ShadowRoot) {
      parts.unshift('::shadow');
      node = root.host;
      continue;
    }
    node = null;
  }

  return JSON.stringify(parts);
}
