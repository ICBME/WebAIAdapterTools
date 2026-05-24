import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildAdapterSource, buildWorkerConfigSnippet, ensureLocatorValidationGate, writeAdapterFromCapture } from '../src/adapterGenerator.js';

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

function v2Plan(template, extra = {}) {
  const base = plan();
  base.schemaVersion = 'web-adapter-tools.interface-plan.v2';
  base.operation.template = template;
  Object.assign(base.operation, extra);
  return base;
}

function profileElement(overrides = {}) {
  return {
    idRef: overrides.idRef || 'el_1',
    tag: overrides.tag || 'textarea',
    role: overrides.role || '',
    type: overrides.type || '',
    id: overrides.id || '',
    className: overrides.className || '',
    attributes: overrides.attributes || {},
    text: overrides.text || '',
    placeholder: overrides.placeholder || '',
    ariaLabel: overrides.ariaLabel || '',
    labelText: overrides.labelText || '',
    visible: overrides.visible ?? true,
    cssPath: overrides.cssPath || '',
    categories: overrides.categories || ['input']
  };
}

async function writeValidationCapture(capture, elements) {
  await fs.mkdir(path.join(capture, 'elements'), { recursive: true });
  await fs.writeFile(path.join(capture, 'profile.json'), JSON.stringify({
    files: {
      beforeElements: 'elements/before.json',
      elements: 'elements/after.json'
    }
  }), 'utf8');
  await fs.writeFile(path.join(capture, 'interface.json'), JSON.stringify(plan()), 'utf8');
  await fs.writeFile(path.join(capture, 'elements/before.json'), JSON.stringify({ all: elements.before }), 'utf8');
  await fs.writeFile(path.join(capture, 'elements/after.json'), JSON.stringify({ all: elements.after }), 'utf8');
}

test('buildAdapterSource creates a WebAI2API manifest adapter', () => {
  const source = buildAdapterSource(plan(), {
    id: 'example_search_text',
    model: 'example-search',
    displayName: 'Example Search'
  });

  assert.match(source, /export const manifest/);
  assert.match(source, /id: 'example_search_text'|"example_search_text"/);
  assert.match(source, /"template": "search_text"/);
  assert.match(source, /page\.getByRole\("textbox"/);
  assert.match(source, /page\.locator\("\[aria-label=/);
});

test('buildAdapterSource creates a WEB2WEB sidecar adapter', () => {
  const source = buildAdapterSource(plan(), {
    id: 'example_search_text',
    model: 'example-search',
    displayName: 'Example Search',
    targetKind: 'web2web-sidecar'
  });

  assert.match(source, /import \{ gotoWithCheck, humanType, normalizeError, safeClick, sleep, uploadFilesViaChooser, waitForInput \} from '\.\.\/browser\/actions\.js'/);
  assert.match(source, /export async function generate\(ctx, req = \{\}\)/);
  assert.match(source, /export async function preload\(ctx, options = \{\}\)/);
  assert.match(source, /export const manifest/);
  assert.doesNotMatch(source, /adapter_runtime\/templateRunner/);
});

test('buildAdapterSource carries v2 IR template fields into generated specs', () => {
  const uploadPlan = v2Plan('upload_text', {
    inputs: [
      ...plan().operation.inputs,
      {
        name: 'file',
        type: 'file',
        required: false,
        locator: {
          value: 'page.getByRole("button", { name: "Upload" })',
          confidence: 0.9
        }
      }
    ],
    waitSignals: [
      {
        type: 'network-response',
        method: 'POST',
        url: { path: '/api/upload', display: 'https://example.com/api/upload' }
      }
    ],
    extractors: [
      {
        name: 'result',
        type: 'text',
        strategy: 'dom-text',
        extract: 'innerText'
      }
    ]
  });
  const source = buildAdapterSource(uploadPlan, { id: 'upload_text_adapter' });
  assert.match(source, /"template": "upload_text"/);
  assert.match(source, /"imagePolicy": "optional"/);
  assert.match(source, /uploads: \[/);
  assert.match(source, /page\.getByRole\("button", \{ name: "Upload" \}\)/);
  assert.match(source, /"waitSignals": \[/);

  const imagePlan = v2Plan('download_image', {
    outputs: [
      {
        name: 'image',
        type: 'image',
        extract: 'attribute:src',
        locator: {
          value: 'page.locator("img.result")',
          confidence: 0.8
        }
      }
    ],
    extractors: [
      {
        name: 'image',
        type: 'image',
        strategy: 'dom-image-url',
        extract: 'attribute:src'
      }
    ]
  });
  const imageSource = buildAdapterSource(imagePlan, { id: 'image_adapter' });
  assert.match(imageSource, /"template": "download_image"/);
  assert.match(imageSource, /"type": "image"/);
  assert.match(imageSource, /attribute:src/);
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

test('writeAdapterFromCapture writes importable WEB2WEB sidecar adapter file', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'web-adapter-tools-generated-sidecar-target-'));
  const capture = await fs.mkdtemp(path.join(os.tmpdir(), 'web-adapter-tools-generated-sidecar-capture-'));
  await fs.mkdir(path.join(root, 'sidecar/src/browser'), { recursive: true });
  await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ type: 'module' }), 'utf8');
  await fs.writeFile(path.join(root, 'sidecar/src/browser/actions.js'), `
export async function gotoWithCheck(page, url) { page.gotoUrl = url; }
export async function waitForInput() {}
export async function safeClick() {}
export async function humanType(page, target, text) { page.typed = text; target.typed = text; }
export async function sleep() {}
export async function uploadFilesViaChooser() {}
export function normalizeError(err, stage) { return { error: err.message, stage }; }
`, 'utf8');
  await fs.writeFile(path.join(capture, 'interface.json'), JSON.stringify(plan()), 'utf8');

  const result = await writeAdapterFromCapture(capture, {
    target: root,
    id: 'example_search_text',
    model: 'example-search',
    targetKind: 'web2web-sidecar'
  });

  assert.equal(result.adapterPath, path.join(root, 'sidecar/src/adapters/example_search_text.js'));
  assert.equal(result.targetKind, 'web2web-sidecar');
  const module = await import(pathToFileURL(result.adapterPath).href);
  assert.equal(module.manifest.id, 'example_search_text');
  assert.equal(typeof module.generate, 'function');
  assert.equal(typeof module.preload, 'function');

  const inputLocator = {
    first() { return this; },
    fill() {},
    pressKey: '',
    async press(key) { this.pressKey = key; },
    async waitFor() {},
    async innerText() { return ''; }
  };
  const outputLocator = {
    first() { return this; },
    async waitFor() {},
    async innerText() { return 'ok'; }
  };
  const page = {
    getByRole() { return inputLocator; },
    locator() { return outputLocator; },
    keyboard: {
      async down() {},
      async press() {},
      async up() {}
    }
  };

  assert.deepEqual(await module.generate({ page }, { prompt: 'hello', model: 'example-search' }), { text: 'ok' });
  assert.equal(page.gotoUrl, 'https://example.com/');
  assert.equal(page.typed, 'hello');
  assert.match(result.configSnippet, /"type": "example_search_text"/);
});

test('ensureLocatorValidationGate generates artifacts and annotates interface plans', async () => {
  const capture = await fs.mkdtemp(path.join(os.tmpdir(), 'web-adapter-tools-gated-capture-'));
  const input = profileElement({
    idRef: 'el_input',
    tag: 'textarea',
    labelText: 'Search',
    placeholder: 'Search',
    categories: ['input']
  });
  const output = profileElement({
    idRef: 'el_output',
    tag: 'section',
    ariaLabel: 'Search Results',
    text: 'Result text',
    categories: ['output']
  });
  await writeValidationCapture(capture, {
    before: [input, output],
    after: [input, output]
  });

  const gate = await ensureLocatorValidationGate(capture, {
    minLocatorScore: 70,
    writeValidation: true
  });
  const annotated = JSON.parse(await fs.readFile(path.join(capture, 'interface.json'), 'utf8'));

  assert.equal(gate.generated, true);
  assert.equal(gate.validation.ok, true);
  assert.ok(await fs.readFile(path.join(capture, 'locator-validation.json'), 'utf8'));
  assert.equal(annotated.locatorValidation.ok, true);
  assert.equal(annotated.operation.outputs[0].locator.stability.status, 'stable');
});

test('ensureLocatorValidationGate rejects locators below the requested threshold', async () => {
  const capture = await fs.mkdtemp(path.join(os.tmpdir(), 'web-adapter-tools-rejected-capture-'));
  const input = profileElement({
    idRef: 'el_input',
    tag: 'textarea',
    labelText: 'Search',
    placeholder: 'Search',
    categories: ['input']
  });
  const output = profileElement({
    idRef: 'el_output',
    tag: 'section',
    ariaLabel: 'Search Results',
    text: 'Result text',
    categories: ['output']
  });
  await writeValidationCapture(capture, {
    before: [input],
    after: [input, output]
  });

  await assert.rejects(
    () => ensureLocatorValidationGate(capture, { minLocatorScore: 70 }),
    /Locator validation failed:/
  );
  assert.ok(await fs.readFile(path.join(capture, 'locator-validation.json'), 'utf8'));
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

test('buildWorkerConfigSnippet creates a WEB2WEB JSON worker example', () => {
  const snippet = buildWorkerConfigSnippet('example_search_text', {
    workerName: 'example_worker',
    targetKind: 'web2web-sidecar'
  });
  assert.match(snippet, /"name": "example_worker"/);
  assert.match(snippet, /"type": "example_search_text"/);
  assert.doesNotMatch(snippet, /type: example_search_text/);
});
