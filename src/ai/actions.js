export const ACTION_SPECS = [
  {
    name: 'fill',
    description: 'replace an editable text input with a value; requires targetRef and params.valueFrom "aiInput" or params.value',
    requiresTarget: true,
    requiresEditable: true
  },
  {
    name: 'type',
    description: 'type text into an editable input without clearing existing content; requires targetRef and params.valueFrom "aiInput" or params.value',
    requiresTarget: true,
    requiresEditable: true
  },
  {
    name: 'clear',
    description: 'clear an editable text input; requires targetRef',
    requiresTarget: true,
    requiresEditable: true
  },
  {
    name: 'click',
    description: 'click a safe visible element; requires targetRef',
    requiresTarget: true
  },
  {
    name: 'press',
    description: 'press a keyboard key; params.key is required, targetRef is optional',
    requiresTarget: false
  },
  {
    name: 'select',
    description: 'select an option in a native select element; requires targetRef and one of params.value, params.label, or params.index',
    requiresTarget: true,
    allowedTags: ['select']
  },
  {
    name: 'check',
    description: 'check a checkbox or switch; requires targetRef',
    requiresTarget: true,
    allowedTypes: ['checkbox', 'radio'],
    allowedRoles: ['checkbox', 'radio', 'switch']
  },
  {
    name: 'uncheck',
    description: 'uncheck a checkbox or switch; requires targetRef',
    requiresTarget: true,
    allowedTypes: ['checkbox'],
    allowedRoles: ['checkbox', 'switch']
  },
  {
    name: 'hover',
    description: 'hover a safe visible element, usually to reveal a menu or tooltip; requires targetRef',
    requiresTarget: true
  },
  {
    name: 'scroll',
    description: 'scroll the page or scroll targetRef into view; optional params.direction, params.amount, and targetRef',
    requiresTarget: false,
    allowHiddenTarget: true
  },
  {
    name: 'wait',
    description: 'wait for targetRef to become visible or for page network idle; targetRef is optional',
    requiresTarget: false,
    allowHiddenTarget: true
  },
  {
    name: 'waitFor',
    description: 'wait for a condition; supports params.state visible/hidden/attached/detached, params.text, params.loadState, or params.ms',
    requiresTarget: false,
    allowHiddenTarget: true
  },
  {
    name: 'upload',
    description: 'upload user-provided files to a file input; requires targetRef and params.path or params.paths from an allowed upload list',
    requiresTarget: true,
    allowedTags: ['input'],
    allowedTypes: ['file']
  }
];

export const ACTIONS = new Map(ACTION_SPECS.map(spec => [spec.name, spec]));

export function getActionSpec(name) {
  return ACTIONS.get(name) || null;
}

export function isKnownAiAction(name) {
  return ACTIONS.has(name);
}

export function aiActionNames() {
  return [...ACTIONS.keys()];
}

export function renderActionSpecsForPrompt() {
  return ACTION_SPECS.map(spec => `- ${spec.name}: ${spec.description}.`).join('\n');
}

export function normalizeDecisionParams(decision = {}) {
  const params = decision.params && typeof decision.params === 'object' && !Array.isArray(decision.params)
    ? { ...decision.params }
    : {};
  if (decision.value !== undefined && params.value === undefined) params.value = decision.value;
  if (decision.valueFrom !== undefined && params.valueFrom === undefined) params.valueFrom = decision.valueFrom;
  if (decision.key !== undefined && params.key === undefined) params.key = decision.key;
  if (decision.text !== undefined && params.text === undefined) params.text = decision.text;
  if (decision.path !== undefined && params.path === undefined) params.path = decision.path;
  if (decision.paths !== undefined && params.paths === undefined) params.paths = decision.paths;
  return params;
}
