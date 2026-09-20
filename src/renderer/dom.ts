// Reconcile in place so text controls retain focus, selection and native Undo history.
export function updateDOM(target: Element, html: string) {
  const template = document.createElement('template');
  template.innerHTML = html;
  reconcile(target, template.content);
}

function key(node: Node): string {
  if (!(node instanceof Element)) return String(node.nodeType);
  return [
    node.tagName,
    node.id,
    node.getAttribute('name'),
    node.getAttribute('data-action'),
    node.getAttribute('data-id'),
    node.getAttribute('data-tab'),
    node.getAttribute('data-mode'),
    node.getAttribute('data-message'),
    node.getAttribute('data-plan-card'),
    // Classes identify the stable layout containers; control classes can change with state.
    node.matches('div,section,main,aside,header,footer,nav,form') ? node.className : '',
  ].join('|');
}

function reconcile(target: Node, source: Node) {
  let cursor = target.firstChild;
  for (const next of Array.from(source.childNodes)) {
    let current = cursor;
    while (current && key(current) !== key(next)) current = current.nextSibling;
    if (!current) {
      target.insertBefore(next.cloneNode(true), cursor);
      continue;
    }
    if (current !== cursor) target.insertBefore(current, cursor);
    cursor = current.nextSibling;
    if (current instanceof Element && next instanceof Element) {
      for (const attr of Array.from(current.attributes))
        if (!next.hasAttribute(attr.name)) current.removeAttribute(attr.name);
      for (const attr of Array.from(next.attributes))
        if (current.getAttribute(attr.name) !== attr.value)
          current.setAttribute(attr.name, attr.value);
      // Updating textarea textContent resets its default value/Undo state. Its live value
      // is owned by input handlers (and explicit draft insertion/clearing), not snapshots.
      if (!(current instanceof HTMLTextAreaElement)) reconcile(current, next);
    } else if (current.nodeValue !== next.nodeValue) current.nodeValue = next.nodeValue;
  }
  while (cursor) {
    const next = cursor.nextSibling;
    target.removeChild(cursor);
    cursor = next;
  }
}
