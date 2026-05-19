import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildAdapterSource, buildWorkerConfigSnippet, writeAdapterFromCapture } from '../src/adapterGenerator.js';

function plan() {
  return {
    schemaVersion: 'web-adapter-tools.interface-plan.v1',
    source: {
      initialUrl: { origin: 'https://example.com', path: '/', display: 'https://example.com/' }
    },
    operation: {
      name: 'search',
      transport: 'browser',
      confidence: 95,
      inputs: [
        {
          name: 'query',
          type: 'string',
          locator: {
            value: 'page.getByRole("textbox", { name: "Search" })',
            confidence: 0.92
          }
        }
      ],
      submit: {
        action: 'press',
        key: 'Enter',
        locator: {
          value: 'page.getByRole("textbox", { name: "Search" })',
          confidence: 0.92
        }
      },
      outputs: [
        {
          name: 'result',
          type: 'text',
          locator: {
            value: 'page.locator("[aria-label=\\"Search Results\\"]")',
            confidence: 0.82
          }
        }
      ],
      steps: [
        {
          type: 'goto',
          url: { origin: 'https://example.com', path: '/', display: 'https://example.com/' }
        }
      ]
    }
  };
}

test('buildAdapterSource creates a WebAI2API manifest adapter', () => {
  const source = buildAdapterSource(plan(), {
    id: 'example_search_text',
    model: 'example-search',
    displayName: 'Example Search'
  });

  assert.match(source, /export const manifest/);
  assert.match(source, /id: 'example_search_text'|"example_search_text"/);
  assert.match(source, /template: "search_text"/);
  assert.match(source, /page\.getByRole\("textbox"/);
  assert.match(source, /page\.locator\("\[aria-label=/);
});

test('writeAdapterFromCapture writes importable adapter file', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'web-adapter-tools-generated-target-'));
  const capture = await fs.mkdtemp(path.join(os.tmpdir(), 'web-adapter-tools-generated-capture-'));
  await fs.mkdir(path.join(root, 'src/backend/adapter_runtime'), { recursive: true });
  await fs.writeFile(path.join(root, 'src/backend/adapter_runtime/templateRunner.js'), 'export async function runTemplate() { return { text: "ok" }; }\n', 'utf8');
  await fs.writeFile(path.join(capture, 'interface.json'), JSON.stringify(plan()), 'utf8');
  await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ type: 'module' }), 'utf8');

  const result = await writeAdapterFromCapture(capture, {
    target: root,
    id: 'example_search_text',
    model: 'example-search'
  });

  const module = await import(pathToFileURL(result.adapterPath).href);
  assert.equal(module.manifest.id, 'example_search_text');
  assert.equal(module.manifest.models[0].id, 'example-search');
  assert.equal(module.manifest.models[0].type, 'text');
  assert.equal(module.manifest.models[0].imagePolicy, 'forbidden');
  assert.deepEqual(await module.manifest.generate({}, 'hello', [], 'example-search'), { text: 'ok' });
  assert.match(result.configSnippet, /type: example_search_text/);
});

test('buildAdapterSource rejects unsafe locator expressions', () => {
  const unsafe = plan();
  unsafe.operation.inputs[0].locator.value = 'process.exit(1)';
  assert.throws(() => buildAdapterSource(unsafe, { id: 'bad_adapter' }), /白名单/);
});

test('buildWorkerConfigSnippet creates a WebAI2API worker example', () => {
  const snippet = buildWorkerConfigSnippet('example_search_text', { workerName: 'example_worker' });
  assert.match(snippet, /name: "example_worker"/);
  assert.match(snippet, /type: example_search_text/);
  assert.match(snippet, /instances:/);
});
