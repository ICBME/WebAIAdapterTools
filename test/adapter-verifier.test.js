import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createVisualRecorder, loadAdapterManifest } from '../src/adapterVerifier.js';

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
