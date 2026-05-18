const TEXTBOX_INPUT_TYPES = new Set([
  '', 'text', 'search', 'email', 'url', 'tel', 'password', 'number'
]);

function cleanText(value, max = 80) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function unique(candidates) {
  const seen = new Set();
  return candidates.filter(candidate => {
    if (!candidate?.value || seen.has(candidate.value)) return false;
    seen.add(candidate.value);
    return true;
  });
}

function cssString(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function cssIdSelector(id) {
  const value = String(id || '');
  if (/^[A-Za-z_][A-Za-z0-9_-]*$/.test(value)) return `#${value}`;
  return `[id="${cssString(value)}"]`;
}

function jsString(value) {
  return JSON.stringify(String(value));
}

export function inferRole(element) {
  const explicit = cleanText(element.role, 50);
  if (explicit) return explicit;

  const tag = element.tag;
  const type = String(element.type || '').toLowerCase();

  if (tag === 'button') return 'button';
  if (tag === 'textarea') return 'textbox';
  if (tag === 'select') return 'combobox';
  if (tag === 'a' && element.href) return 'link';
  if (tag === 'input') {
    if (['button', 'submit', 'reset', 'image'].includes(type)) return 'button';
    if (TEXTBOX_INPUT_TYPES.has(type)) return 'textbox';
    if (type === 'checkbox') return 'checkbox';
    if (type === 'radio') return 'radio';
  }
  if (element.contentEditable) return 'textbox';
  return null;
}

export function accessibleName(element) {
  const role = inferRole(element);
  if (element.ariaLabel) return cleanText(element.ariaLabel);
  if (element.labelText) return cleanText(element.labelText);
  if (role === 'textbox' && element.placeholder) return cleanText(element.placeholder);
  if (['button', 'link', 'menuitem', 'option'].includes(role)) return cleanText(element.text);
  return cleanText(element.text || element.placeholder);
}

export function generateLocatorCandidates(element) {
  const candidates = [];
  const role = inferRole(element);
  const name = accessibleName(element);

  if (role) {
    if (name) {
      candidates.push({
        kind: 'role',
        value: `page.getByRole(${jsString(role)}, { name: ${jsString(name)} })`,
        reason: 'stable accessible role and name',
        confidence: 0.92
      });
    }
    candidates.push({
      kind: 'role',
      value: `page.getByRole(${jsString(role)})`,
      reason: 'accessible role fallback',
      confidence: name ? 0.62 : 0.76
    });
  }

  for (const attr of ['data-testid', 'data-test', 'data-cy']) {
    if (element.attributes?.[attr]) {
      candidates.push({
        kind: attr,
        value: `page.locator('[${attr}="${cssString(element.attributes[attr])}"]')`,
        reason: `${attr} is usually stable`,
        confidence: 0.95
      });
    }
  }

  if (element.ariaLabel) {
    candidates.push({
      kind: 'aria-label',
      value: `page.locator('[aria-label="${cssString(element.ariaLabel)}"]')`,
      reason: 'aria-label selector',
      confidence: 0.82
    });
  }

  if (element.placeholder) {
    candidates.push({
      kind: 'placeholder',
      value: `page.locator('[placeholder="${cssString(element.placeholder)}"]')`,
      reason: 'placeholder selector',
      confidence: 0.78
    });
  }

  if (element.id) {
    candidates.push({
      kind: 'id',
      value: `page.locator('${cssIdSelector(element.id)}')`,
      reason: 'id selector',
      confidence: 0.74
    });
  }

  if (element.tag === 'textarea') {
    candidates.push({
      kind: 'css',
      value: "page.locator('textarea')",
      reason: 'textarea fallback',
      confidence: 0.5
    });
  }

  if (element.tag === 'input' && element.type) {
    candidates.push({
      kind: 'css',
      value: `page.locator('input[type="${cssString(element.type)}"]')`,
      reason: 'input type fallback',
      confidence: 0.46
    });
  }

  if (element.cssPath) {
    candidates.push({
      kind: 'css-path',
      value: `page.locator('${String(element.cssPath).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}')`,
      reason: 'generated structural selector',
      confidence: 0.35
    });
  }

  return unique(candidates).sort((a, b) => b.confidence - a.confidence);
}
