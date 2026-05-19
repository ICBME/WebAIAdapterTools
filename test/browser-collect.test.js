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

test('collectPageProfile records multiple action segments', async (t) => {
  try {
    await import('camoufox-js');
    assertCompatibleDependencyVersions();
  } catch {
    t.skip('compatible Camoufox dependencies are not installed');
    return;
  }

  const fixtureUrl = new URL('../fixtures/chat.html', import.meta.url).href;
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'web-adapter-tools-multi-action-'));

  let profile;
  try {
    profile = await collectPageProfile({
      url: fixtureUrl,
      userDataDir: path.join(tempDir, 'profile'),
      headless: true,
      timeout: 30000,
      recordAction: true,
      actionCount: 2,
      waitForUser: async (page, phase, meta = {}) => {
        if (phase === 'prepare') {
          await page.evaluate(() => {
            let count = 0;
            document.querySelector('form')?.addEventListener('submit', event => {
              event.preventDefault();
              count += 1;
              document.querySelector('.assistant-message').textContent = `Answered ${count}.`;
            });
          });
        }
        if (phase === 'record-action') {
          await page.fill('#prompt', `message ${meta.actionIndex}`);
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

  assert.equal(profile.actionCapture.segmentCount, 2);
  assert.equal(profile.actionCapture.segments[0].id, 'action-001');
  assert.equal(profile.actionCapture.segments[1].id, 'action-002');
  assert.ok(profile.actionCapture.events.some(event => event.actionId === 'action-001'));
  assert.ok(profile.actionCapture.events.some(event => event.actionId === 'action-002'));
  assert.equal(profile.actionCapture.segments[0].diff.counts.textChanged >= 1, true);
});

test('collectPageProfile records AI assist action with controller log', async (t) => {
  try {
    await import('camoufox-js');
    assertCompatibleDependencyVersions();
  } catch {
    t.skip('compatible Camoufox dependencies are not installed');
    return;
  }

  const fixtureUrl = new URL('../fixtures/chat.html', import.meta.url).href;
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'web-adapter-tools-ai-assist-'));

  let profile;
  try {
    profile = await collectPageProfile({
      url: fixtureUrl,
      userDataDir: path.join(tempDir, 'profile'),
      headless: true,
      timeout: 30000,
      aiRecordAction: true,
      aiMode: 'assist',
      aiGoal: 'send a message and wait for the response',
      aiInput: 'hello assist',
      waitForUser: async (page, phase) => {
        if (phase === 'ai-assist') {
          await page.evaluate(() => {
            document.querySelector('form')?.addEventListener('submit', event => {
              event.preventDefault();
              document.querySelector('.assistant-message').textContent = 'AI assist answered.';
            }, { once: true });
          });
          await page.fill('#prompt', 'hello assist');
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

  assert.equal(profile.actionCapture.mode, 'ai-assist');
  assert.equal(profile.actionCapture.segmentCount, 1);
  assert.equal(profile.actionCapture.segments[0].controller.mode, 'assist');
  assert.equal(profile.actionCapture.segments[0].controller.fallbackCount, 1);
  assert.ok(profile.actionCapture.events.some(event => event.type === 'input'));
  assert.equal(profile.actionCapture.diff.counts.textChanged >= 1, true);
});

test('collectPageProfile records action events from iframes', async (t) => {
  try {
    await import('camoufox-js');
    assertCompatibleDependencyVersions();
  } catch {
    t.skip('compatible Camoufox dependencies are not installed');
    return;
  }

  const fixtureUrl = new URL('../fixtures/chat.html', import.meta.url).href;
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'web-adapter-tools-frame-action-'));

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
            const iframe = document.createElement('iframe');
            iframe.id = 'composer-frame';
            iframe.srcdoc = `
              <!doctype html>
              <html><body>
                <label for="frame-prompt">Frame prompt</label>
                <textarea id="frame-prompt" placeholder="Ask in frame"></textarea>
                <button id="frame-send">Send frame</button>
                <section id="frame-result" aria-live="polite">Ready.</section>
                <script>
                  document.getElementById('frame-send').addEventListener('click', () => {
                    document.getElementById('frame-result').textContent = 'Frame answered.';
                  });
                </script>
              </body></html>
            `;
            document.body.appendChild(iframe);
          });
        }
        if (phase === 'record-action') {
          const frame = page.frameLocator('#composer-frame');
          await frame.locator('#frame-prompt').fill('hello from frame');
          await frame.locator('#frame-send').click();
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
  assert.ok(profile.actionCapture.events.some(event => event.target?.cssPath === '#frame-prompt'));
  assert.ok(profile.actionCapture.events.some(event => event.target?.cssPath === '#frame-send'));
});

test('collectPageProfile preserves action events across same-origin navigation', async (t) => {
  try {
    await import('camoufox-js');
    assertCompatibleDependencyVersions();
  } catch {
    t.skip('compatible Camoufox dependencies are not installed');
    return;
  }

  const fixtureUrl = new URL('../fixtures/chat.html', import.meta.url).href;
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'web-adapter-tools-navigation-action-'));

  let profile;
  try {
    profile = await collectPageProfile({
      url: fixtureUrl,
      userDataDir: path.join(tempDir, 'profile'),
      headless: true,
      timeout: 30000,
      recordAction: true,
      waitForUser: async (page, phase) => {
        if (phase === 'record-action') {
          await page.fill('#prompt', 'navigation event');
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
  assert.ok(profile.actionCapture.diff.urlChanged);
  assert.ok(profile.actionCapture.events.some(event => event.type === 'input'));
  assert.ok(profile.actionCapture.events.some(event => event.type === 'submit'));
});
