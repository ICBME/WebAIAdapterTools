import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildInterfacePlan, loadCaptureBundle, renderInterfaceMarkdown, writeInterfaceArtifacts } from '../src/interfaceAnalyzer.js';

function recommendation(type, elementId, label, locator) {
  return {
    type,
    elementId,
    score: 90,
    reasons: ['test'],
    element: {
      tag: type === 'submit' ? 'button' : type === 'output' ? 'section' : 'textarea',
      role: type === 'submit' ? 'button' : type === 'input' ? 'textbox' : '',
      type: null,
      text: label,
      placeholder: type === 'input' ? label : '',
      ariaLabel: type === 'submit' ? label : '',
      labelText: '',
      visible: true,
      disabled: false,
      bbox: {}
    },
    locatorCandidates: [
      {
        kind: 'test',
        value: locator,
        reason: 'test locator',
        confidence: 0.9
      }
    ]
  };
}

test('buildInterfacePlan turns recorded action evidence into a browser interface plan', () => {
  const bundle = {
    profile: {
      capture: {
        capturedAt: '2026-05-18T00:00:00.000Z',
        finalUrl: { origin: 'https://example.com', path: '/chat', queryKeys: [], display: 'https://example.com/chat' }
      }
    },
    activePage: {
      title: 'Chat',
      url: { origin: 'https://example.com', path: '/chat', queryKeys: [], display: 'https://example.com/chat' }
    },
    activeRecommendations: {
      inputs: [recommendation('input', 'el_1', 'Ask anything', "page.getByRole('textbox')")],
      uploads: [],
      submits: [recommendation('submit', 'el_2', 'Send message', "page.getByRole('button', { name: 'Send message' })")],
      outputs: [recommendation('output', 'el_3', 'Assistant response', "page.locator('.assistant-message')")]
    },
    actionEvents: {
      mode: 'manual',
      events: [
        {
          seq: 1,
          type: 'input',
          target: { tag: 'textarea', role: 'textbox', placeholder: 'Ask anything', cssPath: '#prompt' },
          input: { length: 11, preview: 'hello world', redacted: false }
        },
        {
          seq: 2,
          type: 'click',
          target: { tag: 'button', role: 'button', ariaLabel: 'Send message', cssPath: '#send' }
        },
        {
          seq: 3,
          type: 'submit',
          submitter: { tag: 'button', role: 'button', ariaLabel: 'Send message', cssPath: '#send' }
        }
      ]
    },
    actionDiff: {
      beforeUrl: { origin: 'https://example.com', path: '/chat', queryKeys: [], display: 'https://example.com/chat' },
      counts: { textChanged: 1 },
      textChanged: [
        {
          after: {
            tag: 'section',
            role: 'status',
            text: 'Answered.',
            visible: true,
            cssPath: '.assistant-message',
            categories: ['output']
          }
        }
      ]
    },
    actionNetwork: {
      requests: [
        {
          method: 'POST',
          resourceType: 'fetch',
          status: 200,
          failure: null,
          url: { origin: 'https://example.com', path: '/api/chat', queryKeys: [], display: 'https://example.com/api/chat' }
        },
        {
          method: 'POST',
          resourceType: 'xhr',
          status: 204,
          failure: null,
          url: { origin: 'https://example.com', path: '/telemetry/events', queryKeys: [], display: 'https://example.com/telemetry/events' }
        }
      ]
    }
  };

  const plan = buildInterfacePlan(bundle);
  assert.equal(plan.schemaVersion, 'web-adapter-tools.interface-plan.v2');
  assert.equal(plan.operation.name, 'send_message');
  assert.equal(plan.operation.template, 'sse_text');
  assert.equal(plan.operation.inputs[0].name, 'prompt');
  assert.equal(plan.operation.submit.source, 'recorded-submit');
  assert.equal(plan.operation.outputs[0].preview, 'Answered.');
  assert.equal(plan.operation.waitSignals.some(signal => signal.type === 'dom-visible'), true);
  assert.equal(plan.operation.waitSignals.some(signal => signal.type === 'network-stream'), true);
  assert.equal(plan.operation.extractors[0].strategy, 'dom-text');
  assert.equal(plan.operation.errorDetectors.some(detector => detector.type === 'empty-output'), true);
  assert.equal(plan.networkCandidates[0].url.path, '/api/chat');
  assert.ok(plan.operation.confidence >= 80);
  assert.match(renderInterfaceMarkdown(plan), /Template: sse_text/);
  assert.match(renderInterfaceMarkdown(plan), /POST https:\/\/example.com\/api\/chat/);
});

test('loadCaptureBundle and writeInterfaceArtifacts support capture directories', async () => {
  const captureDir = await fs.mkdtemp(path.join(os.tmpdir(), 'web-adapter-tools-interface-'));
  await fs.mkdir(path.join(captureDir, 'pages'), { recursive: true });
  await fs.mkdir(path.join(captureDir, 'recommendations'), { recursive: true });

  await fs.writeFile(path.join(captureDir, 'profile.json'), JSON.stringify({
    files: {
      page: 'pages/current.json',
      recommendations: 'recommendations/current.json'
    },
    capture: {
      finalUrl: { origin: 'https://example.com', path: '/search', queryKeys: ['q'], display: 'https://example.com/search?q=...' }
    }
  }), 'utf8');
  await fs.writeFile(path.join(captureDir, 'pages/current.json'), JSON.stringify({
    title: 'Search',
    url: { origin: 'https://example.com', path: '/search', queryKeys: ['q'], display: 'https://example.com/search?q=...' }
  }), 'utf8');
  await fs.writeFile(path.join(captureDir, 'recommendations/current.json'), JSON.stringify({
    inputs: [recommendation('input', 'el_1', 'Search', "page.getByRole('textbox')")],
    uploads: [],
    submits: [recommendation('submit', 'el_2', 'Search', "page.getByRole('button', { name: 'Search' })")],
    outputs: []
  }), 'utf8');

  const bundle = await loadCaptureBundle(captureDir);
  const plan = buildInterfacePlan(bundle);
  await writeInterfaceArtifacts(plan, captureDir);

  const written = JSON.parse(await fs.readFile(path.join(captureDir, 'interface.json'), 'utf8'));
  assert.equal(written.schemaVersion, 'web-adapter-tools.interface-plan.v2');
  assert.equal(written.operation.name, 'search');
  assert.equal(written.operation.template, 'search_text');
  assert.ok(await fs.readFile(path.join(captureDir, 'interface.md'), 'utf8'));
});
