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
      segmentCount: 1,
      segments: [
        {
          id: 'action-001',
          index: 1,
          label: 'send',
          mode: 'manual',
          events: [{ seq: 1, type: 'click' }],
          before,
          after,
          diff: { counts: { addedElements: 1 } },
          network: { summary: {}, requests: [{ id: 1 }] },
          controller: {
            schemaVersion: 'web-adapter-tools.ai-controller.v1',
            mode: 'hybrid',
            completed: true,
            fallbackCount: 1,
            stepCount: 2,
            steps: []
          }
        }
      ],
      before,
      after,
      diff: { counts: { addedElements: 1 } },
      network: { summary: {}, requests: [{ id: 1 }] }
    }
  };

  const index = await writeCaptureArtifacts(profile, outDir);
  assert.equal(index.schemaVersion, 'web-adapter-tools.capture-bundle.v1');
  assert.equal(index.files.actionEvents, 'actions/events.json');
  assert.equal(index.files.actionSegments, 'actions/segments.json');

  const profileIndex = JSON.parse(await fs.readFile(path.join(outDir, 'profile.json'), 'utf8'));
  const events = JSON.parse(await fs.readFile(path.join(outDir, 'actions/events.json'), 'utf8'));
  const segments = JSON.parse(await fs.readFile(path.join(outDir, 'actions/segments.json'), 'utf8'));
  const segmentEvents = JSON.parse(await fs.readFile(path.join(outDir, 'actions/segments/action-001/events.json'), 'utf8'));
  const afterPage = JSON.parse(await fs.readFile(path.join(outDir, 'pages/after.json'), 'utf8'));

  assert.equal(profileIndex.action.eventCount, 1);
  assert.equal(profileIndex.action.segmentCount, 1);
  assert.equal(profileIndex.action.recorderInstalled, true);
  assert.equal(profileIndex.action.controllerCount, 1);
  assert.equal(profileIndex.action.fallbackCount, 1);
  assert.equal(events.recorderInstalled, true);
  assert.equal(events.events[0].type, 'click');
  assert.equal(segments.segmentCount, 1);
  assert.equal(segmentEvents.id, 'action-001');
  assert.equal(segments.segments[0].files.controller, 'actions/segments/action-001/controller.json');
  assert.equal(segments.segments[0].controller.completed, true);
  assert.equal(afterPage.title, 'after');

  const controller = JSON.parse(await fs.readFile(path.join(outDir, 'actions/segments/action-001/controller.json'), 'utf8'));
  assert.equal(controller.mode, 'hybrid');
});
