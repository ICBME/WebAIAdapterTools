import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { writeCaptureArtifacts } from '../src/artifacts.js';

function snapshot(title) {
  return {
    page: { title, url: { display: `https://example.com/${title}` } },
    elements: {
      all: [],
      inputs: [],
      buttons: [],
      fileInputs: [],
      links: [],
      forms: [],
      outputContainers: []
    },
    recommendations: {
      inputs: [],
      uploads: [],
      submits: [],
      outputs: []
    }
  };
}

test('writeCaptureArtifacts writes a structured capture bundle', async () => {
  const outDir = await fs.mkdtemp(path.join(os.tmpdir(), 'web-adapter-tools-artifacts-'));
  const before = snapshot('before');
  const after = snapshot('after');
  const profile = {
    schemaVersion: 'web-adapter-tools.profile.v1',
    capture: { capturedAt: '2026-05-18T00:00:00.000Z' },
    page: before.page,
    elements: before.elements,
    recommendations: before.recommendations,
    network: { summary: {}, requests: [] },
    actionCapture: {
      mode: 'manual',
      instructions: 'test',
      recorderInstalled: true,
      recorderInstallError: null,
      events: [{ seq: 1, type: 'click' }],
      before,
      after,
      diff: { counts: { addedElements: 1 } },
      network: { summary: {}, requests: [{ id: 1 }] }
    }
  };

  const index = await writeCaptureArtifacts(profile, outDir);
  assert.equal(index.schemaVersion, 'web-adapter-tools.capture-bundle.v1');
  assert.equal(index.files.actionEvents, 'actions/events.json');

  const profileIndex = JSON.parse(await fs.readFile(path.join(outDir, 'profile.json'), 'utf8'));
  const events = JSON.parse(await fs.readFile(path.join(outDir, 'actions/events.json'), 'utf8'));
  const afterPage = JSON.parse(await fs.readFile(path.join(outDir, 'pages/after.json'), 'utf8'));

  assert.equal(profileIndex.action.eventCount, 1);
  assert.equal(profileIndex.action.recorderInstalled, true);
  assert.equal(events.recorderInstalled, true);
  assert.equal(events.events[0].type, 'click');
  assert.equal(afterPage.title, 'after');
});
