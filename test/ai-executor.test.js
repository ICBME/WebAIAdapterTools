import test from 'node:test';
import assert from 'node:assert/strict';
import { buildAiObservation, serializeObservationForAi } from '../src/ai/observation.js';
import { executeAiDecision, shouldFallbackDecision } from '../src/ai/executor.js';
import { createAiProvider, normalizeAiDecision } from '../src/ai/provider.js';

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
  return {
    page: {
      title: 'Fixture Chat',
      url: { display: 'https://example.com/chat' },
      readyState: 'complete',
      textStats: { preview: 'Ready. Message Send' },
      counts: {}
    },
    elements: { all: [input, button] },
    recommendations: {
      inputs: [{ elementId: 'el_1', score: 99, reasons: [], element: {} }],
      submits: [{ elementId: 'el_2', score: 90, reasons: [], element: {} }],
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
  const raw = await createAiProvider({ providerType: 'raw', apiKey: 'sk-test' });
  const langgraph = await createAiProvider({ providerType: 'langgraph', apiKey: 'sk-test', model: 'gpt-test' });
  assert.equal(raw.type, 'raw');
  assert.equal(langgraph.type, 'langgraph');
  assert.throws(() => createAiProvider({ providerType: 'unknown' }), /Unsupported AI provider/);
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
