import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectPageProfile } from '../src/collector.js';
import { renderHtmlReport } from '../src/htmlReport.js';
import { assertCompatibleDependencyVersions } from '../src/versionGuard.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

test('collectPageProfile profiles local fixture when Camoufox is available', async (t) => {
  try {
    await import('camoufox-js');
    assertCompatibleDependencyVersions();
  } catch {
    t.skip('compatible Camoufox dependencies are not installed');
    return;
  }

  const fixtureUrl = new URL('../fixtures/chat.html', import.meta.url).href;
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'web-adapter-tools-profile-'));

  let profile;
  try {
    profile = await collectPageProfile({
      url: fixtureUrl,
      userDataDir: path.join(tempDir, 'profile'),
      headless: true,
      timeout: 30000
    });
  } catch (error) {
    if (/executable|Camoufox|browser|ENOENT|missing|install/i.test(error.message)) {
      t.skip(`Camoufox runtime unavailable: ${error.message}`);
      return;
    }
    throw error;
  }

  assert.equal(profile.schemaVersion, 'web-adapter-tools.profile.v1');
  assert.ok(profile.elements.inputs.length >= 1);
  assert.ok(profile.elements.fileInputs.length >= 1);
  assert.ok(profile.recommendations.inputs[0].score > 0);
  assert.match(renderHtmlReport(profile), /WebAdapterTools Page Profile/);
  assert.ok(__dirname);
});

test('collectPageProfile records safe manual action events', async (t) => {
  try {
    await import('camoufox-js');
    assertCompatibleDependencyVersions();
  } catch {
    t.skip('compatible Camoufox dependencies are not installed');
    return;
  }

  const fixtureUrl = new URL('../fixtures/chat.html', import.meta.url).href;
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'web-adapter-tools-action-'));

  let profile;
  try {
    profile = await collectPageProfile({
      url: fixtureUrl,
      userDataDir: path.join(tempDir, 'profile'),
      headless: true,
      timeout: 30000,
      recordAction: true,
      waitForUser: async (page, phase) => {
        if (phase === 'prepare') {
          await page.evaluate(() => {
            document.querySelector('form')?.addEventListener('submit', event => {
              event.preventDefault();
              document.querySelector('.assistant-message').textContent = 'Answered.';
            });
          });
        }
        if (phase === 'record-action') {
          await page.click('#prompt');
          await page.keyboard.type('hello world');
          await page.click('button[aria-label="Send message"]');
        }
      }
    });
  } catch (error) {
    if (/executable|Camoufox|browser|ENOENT|missing|install/i.test(error.message)) {
      t.skip(`Camoufox runtime unavailable: ${error.message}`);
      return;
    }
    throw error;
  }

  assert.equal(profile.actionCapture.recorderInstalled, true);
  assert.ok(profile.actionCapture.events.some(event => event.type === 'input'));
  assert.ok(profile.actionCapture.events.some(event => event.type === 'click'));
  assert.ok(profile.actionCapture.events.some(event => event.type === 'submit'));
  const inputEvent = profile.actionCapture.events.find(event => event.type === 'input');
  assert.equal(inputEvent.input.preview, 'hello world');
  assert.equal(profile.actionCapture.diff.counts.textChanged >= 1, true);
});
