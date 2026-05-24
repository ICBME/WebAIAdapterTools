import test from 'node:test';
import assert from 'node:assert/strict';
import { buildAiObservation, serializeObservationForAi } from '../src/ai/observation.js';
import { executeAiDecision, shouldFallbackDecision } from '../src/ai/executor.js';
import { createAiProvider, normalizeAiDecision, resolveAiTimeout } from '../src/ai/provider.js';

function snapshot() {
  const input = {
    idRef: 'el_1',
    categories: ['input'],
    tag: 'textarea',
    role: 'textbox',
    type: '',
    name: 'prompt',
    text: '',
    placeholder: 'Ask anything',
    ariaLabel: '',
    labelText: 'Message',
    visible: true,
    disabled: false,
    readOnly: false,
    cssPath: '#prompt',
    bbox: { x: 10, y: 10, width: 200, height: 40 }
  };
  const button = {
    idRef: 'el_2',
    categories: ['button'],
    tag: 'button',
    role: '',
    type: 'submit',
    name: '',
    text: 'Send',
    placeholder: '',
    ariaLabel: 'Send message',
    labelText: '',
    visible: true,
    disabled: false,
    readOnly: false,
    cssPath: '#send',
    bbox: { x: 220, y: 10, width: 80, height: 40 }
  };
  const select = {
    idRef: 'el_3',
    categories: ['select'],
    tag: 'select',
    role: '',
    type: '',
    name: 'model',
    text: '',
    placeholder: '',
    ariaLabel: 'Model',
    labelText: 'Model',
    visible: true,
    disabled: false,
    readOnly: false,
    cssPath: '#model',
    options: [
      { index: 0, value: 'mini', label: 'Mini', selected: true, disabled: false },
      { index: 1, value: 'pro', label: 'Pro', selected: false, disabled: false }
    ],
    bbox: { x: 10, y: 80, width: 160, height: 32 }
  };
  const checkbox = {
    idRef: 'el_4',
    categories: ['toggle'],
    tag: 'input',
    role: '',
    type: 'checkbox',
    name: 'agree',
    text: '',
    placeholder: '',
    ariaLabel: 'Agree',
    labelText: 'Agree',
    visible: true,
    disabled: false,
    readOnly: false,
    checked: false,
    cssPath: '#agree',
    bbox: { x: 10, y: 130, width: 20, height: 20 }
  };
  return {
    page: {
      title: 'Fixture Chat',
      url: { display: 'https://example.com/chat' },
      readyState: 'complete',
      textStats: { preview: 'Ready. Message Send' },
      counts: {}
    },
    elements: { all: [input, button, select, checkbox] },
    recommendations: {
      inputs: [{ elementId: 'el_1', score: 99, reasons: [], element: {} }],
      submits: [{ elementId: 'el_2', score: 90, reasons: [], element: {} }],
      selects: [{ elementId: 'el_3', score: 75, reasons: [], element: {} }],
      outputs: [],
      uploads: []
    }
  };
}

test('buildAiObservation exposes safe serializable element refs', () => {
  const observation = buildAiObservation(snapshot(), {
    goal: 'send a message',
    aiInput: 'hello',
    stepIndex: 1
  });
  const serialized = serializeObservationForAi(observation);
  assert.equal(observation.targetMap.get('el_1').cssPath, '#prompt');
  assert.equal(serialized.targetMap, undefined);
  assert.equal(serialized.elements[0].idRef, 'el_1');
});

test('executeAiDecision supports params DSL for type and clear', async () => {
  const observation = buildAiObservation(snapshot(), { aiInput: 'hello' });
  const calls = [];
  const locator = {
    first: () => locator,
    waitFor: async () => calls.push(['waitFor']),
    type: async (value, options) => calls.push(['type', value, options?.delay]),
    fill: async value => calls.push(['fill', value])
  };
  const page = {
    locator: selector => {
      calls.push(['locator', selector]);
      return locator;
    }
  };

  const typed = await executeAiDecision(page, observation, {
    mode: 'execute',
    confidence: 0.9,
    action: 'type',
    targetRef: 'el_1',
    params: { valueFrom: 'aiInput', delay: 5 }
  });
  const cleared = await executeAiDecision(page, observation, {
    mode: 'execute',
    confidence: 0.9,
    action: 'clear',
    targetRef: 'el_1'
  });

  assert.equal(typed.ok, true);
  assert.equal(cleared.ok, true);
  assert.deepEqual(calls, [
    ['locator', '#prompt'],
    ['waitFor'],
    ['type', 'hello', 5],
    ['locator', '#prompt'],
    ['waitFor'],
    ['fill', '']
  ]);
});

test('executeAiDecision selects and checks safe form controls', async () => {
  const observation = buildAiObservation(snapshot(), { aiInput: 'hello' });
  const calls = [];
  const locators = {
    '#model': {
      first() { return this; },
      waitFor: async () => calls.push(['waitFor', '#model']),
      selectOption: async option => calls.push(['selectOption', option])
    },
    '#agree': {
      first() { return this; },
      waitFor: async () => calls.push(['waitFor', '#agree']),
      check: async () => calls.push(['check'])
    }
  };
  const page = {
    locator: selector => {
      calls.push(['locator', selector]);
      return locators[selector];
    }
  };

  const selected = await executeAiDecision(page, observation, {
    mode: 'execute',
    confidence: 0.9,
    action: 'select',
    targetRef: 'el_3',
    params: { label: 'Pro' }
  });
  const checked = await executeAiDecision(page, observation, {
    mode: 'execute',
    confidence: 0.9,
    action: 'check',
    targetRef: 'el_4'
  });

  assert.equal(selected.ok, true);
  assert.equal(checked.ok, true);
  assert.deepEqual(calls, [
    ['locator', '#model'],
    ['waitFor', '#model'],
    ['selectOption', { label: 'Pro' }],
    ['locator', '#agree'],
    ['waitFor', '#agree'],
    ['check']
  ]);
});

test('executeAiDecision supports scroll and waitFor actions', async () => {
  const observation = buildAiObservation(snapshot(), { aiInput: 'hello' });
  const calls = [];
  const locator = {
    first: () => locator,
    waitFor: async options => calls.push(['waitFor', options]),
    textContent: async () => 'Ready. Message Send'
  };
  const page = {
    locator: selector => {
      calls.push(['locator', selector]);
      return locator;
    },
    mouse: {
      wheel: async (x, y) => calls.push(['wheel', x, y])
    }
  };

  const scrolled = await executeAiDecision(page, observation, {
    mode: 'execute',
    confidence: 0.9,
    action: 'scroll',
    params: { direction: 'down', amount: 300 }
  });
  const waited = await executeAiDecision(page, observation, {
    mode: 'execute',
    confidence: 0.9,
    action: 'waitFor',
    targetRef: 'el_2',
    params: { state: 'visible', text: 'Send' }
  });

  assert.equal(scrolled.ok, true);
  assert.equal(waited.ok, true);
  assert.deepEqual(calls, [
    ['wheel', 0, 300],
    ['locator', '#send'],
    ['waitFor', { state: 'visible', timeout: 10000 }]
  ]);
});

test('executeAiDecision fills a selected targetRef', async () => {
  const observation = buildAiObservation(snapshot(), { aiInput: 'hello' });
  const calls = [];
  const locator = {
    first: () => locator,
    waitFor: async () => calls.push(['waitFor']),
    fill: async value => calls.push(['fill', value])
  };
  const page = {
    locator: selector => {
      calls.push(['locator', selector]);
      return locator;
    }
  };

  const result = await executeAiDecision(page, observation, {
    mode: 'execute',
    confidence: 0.9,
    action: 'fill',
    targetRef: 'el_1',
    valueFrom: 'aiInput'
  });

  assert.equal(result.ok, true);
  assert.deepEqual(calls, [
    ['locator', '#prompt'],
    ['waitFor'],
    ['fill', ''],
    ['fill', 'hello']
  ]);
});

test('executeAiDecision retries click after pointer interception', async () => {
  const observation = buildAiObservation(snapshot(), { aiInput: 'hello' });
  const calls = [];
  let clicks = 0;
  const locator = {
    first: () => locator,
    waitFor: async () => calls.push(['waitFor']),
    click: async options => {
      calls.push(['click', options?.force || false]);
      clicks += 1;
      if (clicks === 1) {
        throw new Error('<div role="tooltip"> subtree intercepts pointer events');
      }
    }
  };
  const page = {
    locator: selector => {
      calls.push(['locator', selector]);
      return locator;
    },
    keyboard: {
      press: async key => calls.push(['key', key])
    },
    mouse: {
      move: async (x, y) => calls.push(['mouse', x, y])
    },
    waitForTimeout: async ms => calls.push(['wait', ms])
  };

  const result = await executeAiDecision(page, observation, {
    mode: 'execute',
    confidence: 0.9,
    action: 'click',
    targetRef: 'el_2'
  });

  assert.equal(result.ok, true);
  assert.equal(result.retries, 1);
  assert.deepEqual(calls, [
    ['locator', '#send'],
    ['waitFor'],
    ['click', false],
    ['key', 'Escape'],
    ['mouse', 1, 1],
    ['wait', 250],
    ['click', false]
  ]);
});

test('executeAiDecision returns fallback when click remains blocked', async () => {
  const observation = buildAiObservation(snapshot(), { aiInput: 'hello' });
  const locator = {
    first: () => locator,
    waitFor: async () => {},
    click: async () => {
      throw new Error('tooltip subtree intercepts pointer events forever');
    }
  };
  const page = {
    locator: () => locator,
    keyboard: { press: async () => {} },
    mouse: { move: async () => {} },
    waitForTimeout: async () => {}
  };

  const result = await executeAiDecision(page, observation, {
    mode: 'execute',
    confidence: 0.9,
    action: 'click',
    targetRef: 'el_2'
  });

  assert.equal(result.ok, false);
  assert.match(result.fallbackReason, /AI click failed/);
});

test('shouldFallbackDecision rejects low confidence and risky missing targets', () => {
  assert.match(shouldFallbackDecision({
    mode: 'execute',
    confidence: 0.2,
    action: 'click',
    targetRef: 'el_2'
  }), /below/);

  assert.match(shouldFallbackDecision({
    mode: 'execute',
    confidence: 0.9,
    action: 'click'
  }), /requires targetRef/);
});

test('createAiProvider constructs raw and langgraph providers', async () => {
  const raw = await createAiProvider({ providerType: 'raw', apiKey: 'sk-test', timeout: 12345 });
  const langgraph = await createAiProvider({ providerType: 'langgraph', apiKey: 'sk-test', model: 'gpt-test', timeout: 23456 });
  assert.equal(raw.type, 'raw');
  assert.equal(raw.timeout, 12345);
  assert.equal(langgraph.type, 'langgraph');
  assert.equal(langgraph.timeout, 23456);
  assert.throws(() => createAiProvider({ providerType: 'unknown' }), /Unsupported AI provider/);
});

test('resolveAiTimeout validates timeout values', () => {
  assert.equal(resolveAiTimeout({ timeout: 5000 }), 5000);
  assert.equal(resolveAiTimeout({ aiTimeout: 6000 }), 6000);
  assert.equal(resolveAiTimeout({ timeout: -1 }), 180000);
});

test('normalizeAiDecision treats valid missing-confidence actions as implicit confidence', () => {
  const decision = normalizeAiDecision({
    mode: 'execute',
    action: 'fill',
    targetRef: 'el_60',
    valueFrom: 'aiInput'
  });

  assert.equal(decision.confidence, 0.8);
  assert.equal(decision.confidenceSource, 'implicit');
  assert.equal(decision.params.valueFrom, 'aiInput');
  assert.equal(shouldFallbackDecision(decision), '');
});

test('normalizeAiDecision normalizes percentage confidence', () => {
  const decision = normalizeAiDecision({
    mode: 'execute',
    confidence: 85,
    action: 'click',
    targetRef: 'el_2'
  });

  assert.equal(decision.confidence, 0.85);
  assert.equal(decision.confidenceSource, 'model');
});

test('normalizeAiDecision accepts params DSL for new actions', () => {
  const decision = normalizeAiDecision({
    mode: 'execute',
    action: 'select',
    targetRef: 'el_3',
    params: { label: 'Pro' }
  });

  assert.equal(decision.confidence, 0.8);
  assert.deepEqual(decision.params, { label: 'Pro' });
  assert.equal(shouldFallbackDecision(decision), '');
});
