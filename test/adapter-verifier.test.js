import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createVisualRecorder, loadAdapterManifest } from '../src/adapterVerifier.js';
import { diagnoseVerifyFailure, writeFailureDiagnosisArtifacts } from '../src/adapterDiagnosis.js';

test('loadAdapterManifest loads and validates a target adapter', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'web-adapter-tools-verify-target-'));
  const adapterDir = path.join(root, 'src/backend/adapter');
  await fs.mkdir(adapterDir, { recursive: true });
  await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ type: 'module' }), 'utf8');
  await fs.writeFile(path.join(adapterDir, 'example_text.js'), `
export const manifest = {
  id: 'example_text',
  models: [{ id: 'example-model', imagePolicy: 'forbidden', type: 'text' }],
  async generate() {
    return { text: 'ok' };
  }
};
`, 'utf8');

  const loaded = await loadAdapterManifest(root, 'example_text');
  assert.equal(loaded.manifest.id, 'example_text');
  assert.equal(loaded.manifest.models[0].id, 'example-model');
  assert.match(loaded.adapterPath, /example_text\.js$/);
});

test('loadAdapterManifest rejects missing generate', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'web-adapter-tools-verify-target-'));
  const adapterDir = path.join(root, 'src/backend/adapter');
  await fs.mkdir(adapterDir, { recursive: true });
  await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ type: 'module' }), 'utf8');
  await fs.writeFile(path.join(adapterDir, 'bad_text.js'), `
export const manifest = {
  id: 'bad_text',
  models: [{ id: 'bad-model', imagePolicy: 'forbidden', type: 'text' }]
};
`, 'utf8');

  await assert.rejects(() => loadAdapterManifest(root, 'bad_text'), /manifest\.generate is missing/);
});

test('createVisualRecorder writes screenshots and timeline artifacts', async () => {
  const outDir = await fs.mkdtemp(path.join(os.tmpdir(), 'web-adapter-tools-visual-'));
  const page = {
    url: () => 'https://example.com/result',
    title: async () => 'Example',
    evaluate: async () => {},
    content: async () => '<html><body>ok</body></html>',
    screenshot: async ({ path: screenshotPath }) => {
      await fs.writeFile(screenshotPath, 'png', 'utf8');
    }
  };

  const recorder = createVisualRecorder(page, { outDir });
  await recorder.init();
  await recorder.step({ name: 'after-fill', label: 'Prompt filled' });
  const artifacts = await recorder.writeArtifacts({
    ok: true,
    adapterId: 'example_text',
    modelId: 'example-model',
    elapsedMs: 42,
    result: { text: 'ok' }
  });

  const verifyJson = JSON.parse(await fs.readFile(artifacts.verifyPath, 'utf8'));
  const timeline = await fs.readFile(artifacts.timelinePath, 'utf8');
  assert.equal(verifyJson.ok, true);
  assert.equal(verifyJson.steps[0].name, 'after-fill');
  assert.match(verifyJson.steps[0].screenshot, /screenshots\/001-after-fill\.png/);
  assert.match(timeline, /Prompt filled/);
});

test('diagnoseVerifyFailure classifies output locator timeout and writes patch artifacts', async () => {
  const outDir = await fs.mkdtemp(path.join(os.tmpdir(), 'web-adapter-tools-diagnose-'));
  const captureDir = await fs.mkdtemp(path.join(os.tmpdir(), 'web-adapter-tools-diagnose-capture-'));
  await fs.writeFile(path.join(captureDir, 'interface.json'), JSON.stringify({
    schemaVersion: 'web-adapter-tools.interface-plan.v2',
    operation: {
      transport: 'browser',
      template: 'sse_text',
      inputs: [{ locator: { value: 'page.getByRole("textbox")' } }],
      submit: { locator: { value: 'page.getByRole("button", { name: "Send" })' } },
      outputs: [{ locator: { value: 'page.locator(".answer")' } }],
      waitSignals: [
        { type: 'dom-visible', locator: { value: 'page.locator(".answer")' } },
        { type: 'network-stream', url: { path: '/api/stream' } }
      ],
      extractors: [{ type: 'text', locator: { value: 'page.locator(".answer")' } }]
    }
  }), 'utf8');
  const summary = {
    ok: false,
    adapterId: 'example_text',
    modelId: 'example-model',
    result: { error: 'Timeout 30000ms exceeded while waiting for locator(".answer")' },
    textLength: 0,
    imageLength: 0,
    artifacts: {
      outDir,
      verifyPath: path.join(outDir, 'verify.json')
    },
    steps: [
      { name: 'before-output-wait', label: 'Wait for output', url: 'https://example.com/app' },
      { name: 'verifier-failed', label: 'Verification failed', error: 'Timeout 30000ms exceeded while waiting for locator(".answer")' }
    ]
  };

  const diagnosis = diagnoseVerifyFailure(summary);
  const artifacts = await writeFailureDiagnosisArtifacts(summary, { outDir, captureDir, writeBack: true });
  const patch = JSON.parse(await fs.readFile(artifacts.patchPath, 'utf8'));
  const annotated = JSON.parse(await fs.readFile(path.join(captureDir, 'interface.json'), 'utf8'));

  assert.equal(diagnosis.primary.type, 'output_locator_timeout');
  assert.equal(artifacts.diagnosis.primary.type, 'output_locator_timeout');
  assert.ok(patch.operations.some(operation => operation.path === '/operation/outputs/0/locator/stability'));
  assert.equal(annotated.verificationDiagnosis.type, 'output_locator_timeout');
});

test('diagnoseVerifyFailure recommends sse_text fallback on network signal timeout', () => {
  const summary = {
    ok: false,
    adapterId: 'example_text',
    result: { error: 'page.waitForResponse: Timeout while waiting for network signal' },
    steps: [
      { name: 'after-submit', label: 'Request submitted' }
    ]
  };

  const diagnosis = diagnoseVerifyFailure(summary);
  assert.equal(diagnosis.primary.type, 'network_signal_timeout');
});
