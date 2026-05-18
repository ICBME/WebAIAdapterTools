function elementKey(element) {
  const parts = [
    element.tag,
    element.role,
    element.type,
    element.id,
    element.name,
    element.ariaLabel,
    element.placeholder,
    element.cssPath
  ];
  return parts.map(part => String(part || '')).join('|');
}

function groupElements(elements) {
  const map = new Map();
  for (const element of elements || []) {
    map.set(elementKey(element), element);
  }
  return map;
}

function summarizeElement(element) {
  return {
    id: element.idRef,
    categories: element.categories,
    tag: element.tag,
    role: element.role,
    type: element.type,
    text: element.text,
    placeholder: element.placeholder,
    ariaLabel: element.ariaLabel,
    visible: element.visible,
    bbox: element.bbox,
    cssPath: element.cssPath
  };
}

export function diffSnapshots(before, after) {
  const beforeElements = groupElements(before?.elements?.all || []);
  const afterElements = groupElements(after?.elements?.all || []);
  const added = [];
  const removed = [];
  const visibilityChanged = [];
  const textChanged = [];

  for (const [key, afterElement] of afterElements) {
    const beforeElement = beforeElements.get(key);
    if (!beforeElement) {
      added.push(summarizeElement(afterElement));
      continue;
    }
    if (Boolean(beforeElement.visible) !== Boolean(afterElement.visible)) {
      visibilityChanged.push({
        before: summarizeElement(beforeElement),
        after: summarizeElement(afterElement)
      });
    }
    if ((beforeElement.text || '') !== (afterElement.text || '')) {
      textChanged.push({
        before: summarizeElement(beforeElement),
        after: summarizeElement(afterElement)
      });
    }
  }

  for (const [key, beforeElement] of beforeElements) {
    if (!afterElements.has(key)) removed.push(summarizeElement(beforeElement));
  }

  return {
    urlChanged: before?.page?.url?.display !== after?.page?.url?.display,
    beforeUrl: before?.page?.url || null,
    afterUrl: after?.page?.url || null,
    pageTitleChanged: before?.page?.title !== after?.page?.title,
    beforeTitle: before?.page?.title || '',
    afterTitle: after?.page?.title || '',
    addedElements: added.slice(0, 50),
    removedElements: removed.slice(0, 50),
    visibilityChanged: visibilityChanged.slice(0, 50),
    textChanged: textChanged.slice(0, 50),
    counts: {
      addedElements: added.length,
      removedElements: removed.length,
      visibilityChanged: visibilityChanged.length,
      textChanged: textChanged.length
    }
  };
}
