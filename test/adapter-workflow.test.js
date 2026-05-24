import test from 'node:test';
import assert from 'node:assert/strict';
import {
  WEBAI2API_ADAPTER_WORKFLOW,
  buildAdapterWorkflowPlan,
  renderAdapterWorkflowMarkdown
} from '../src/adapterWorkflow.js';
import {
  buildAiGoalFromAdapterPlan,
  compactAdapterPlanForAi,
  getBuiltInAdapterPlan,
  renderAdapterPlanMarkdown
} from '../src/adapterPlan.js';

test('buildAdapterWorkflowPlan summarizes common WebAI2API adapter flow', () => {
  const plan = buildAdapterWorkflowPlan({
    url: 'https://example.com/app',
    out: 'captures/example',
    target: '../WebAI2API',
    id: 'Example Text',
    model: 'example-model',
    aiGoal: 'send prompt and wait for answer',
    aiInput: 'hello',
    aiProvider: 'langgraph',
    aiTimeout: 300000
  });

  assert.equal(plan.adapter.id, 'example_text');
  assert.equal(plan.ai.provider, 'langgraph');
  assert.equal(plan.ai.timeoutMs, 300000);
  assert.equal(plan.adapterPlan.id, 'webai2api-chatgpt-reference');
  assert.ok(plan.adapterPlan.operations.some(operation => operation.id === 'enter-prompt'));
  assert.ok(plan.workflow.some(step => step.id === 'wait-output'));
  assert.equal(WEBAI2API_ADAPTER_WORKFLOW.length >= 6, true);
});

test('renderAdapterWorkflowMarkdown includes generated artifact paths', () => {
  const plan = buildAdapterWorkflowPlan({
    url: 'https://example.com/app',
    out: 'captures/example',
    target: '../WebAI2API',
    id: 'example_text',
    aiGoal: 'send prompt'
  });
  const markdown = renderAdapterWorkflowMarkdown(plan, {
    captureIndexPath: 'captures/example/profile.json',
    interfacePath: 'captures/example/interface.json',
    adapterPath: '../WebAI2API/src/backend/adapter/example_text.js',
    locatorValidation: {
      path: 'captures/example/locator-validation.json'
    },
    steps: [
      { id: 'collect', status: 'completed' },
      { id: 'locator-validation', status: 'completed' }
    ],
    ok: true
  });

  assert.match(markdown, /Common WebAI2API Adapter Flow/);
  assert.match(markdown, /Adapter Generation Plan/);
  assert.match(markdown, /Open target page/);
  assert.match(markdown, /example_text\.js/);
  assert.match(markdown, /Locator validation/);
  assert.match(markdown, /Final verdict: passed/);
});

test('built-in ChatGPT reference adapter plan documents required interfaces and operations', () => {
  const plan = getBuiltInAdapterPlan('webai2api-chatgpt-reference');
  const compact = compactAdapterPlanForAi(plan);
  const markdown = renderAdapterPlanMarkdown(plan);
  const goal = buildAiGoalFromAdapterPlan(plan, { aiInput: 'hello' });

  assert.match(plan.moduleContract.generateSignature, /generate\(context, prompt, imgPaths, modelId, meta/);
  assert.ok(plan.operations.some(operation => operation.id === 'extract-text'));
  assert.ok(plan.operations.some(operation => operation.id === 'extract-image'));
  assert.equal(compact.operations.some(operation => operation.id === 'submit-prompt'), true);
  assert.match(markdown, /backend-api\/f\/conversation/);
  assert.match(goal, /adapter plan "webai2api-chatgpt-reference"/);
});
