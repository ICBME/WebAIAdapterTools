import test from 'node:test';
import assert from 'node:assert/strict';
import {
  evaluateLocatorDynamically,
  inferDynamicTargetUrl,
  mergeDynamicLocatorValidation,
  validateInterfaceLocatorsDynamic
} from '../src/dynamicLocatorValidator.js';

function plan() {
  return {
    schemaVersion: 'web-adapter-tools.interface-plan.v2',
    source: {
      initialUrl: { origin: 'https://example.com', path: '/app', display: 'https://example.com/app' }
    },
    operation: {
      transport: 'browser',
      inputs: [
        { type: 'string', locator: { value: 'page.getByRole("textbox", { name: "Prompt" })' } }
      ],
      submit: {
        locator: { value: 'page.getByRole("button", { name: "Send" })' }
      },
      outputs: [
        { type: 'text', locator: { value: 'page.locator("#output")' } }
      ]
    }
  };
}

test('inferDynamicTargetUrl uses explicit target and interface fallback', () => {
  assert.equal(inferDynamicTargetUrl(plan(), {}, { targetUrl: 'https://override.test/' }), 'https://override.test/');
  assert.equal(inferDynamicTargetUrl(plan(), {}, {}), 'https://example.com/app');
});

test('evaluateLocatorDynamically scores editable inputs as stable', async () => {
  const page = new FakePage({
    role: {
      textbox: new FakeLocator({ count: 1, visible: true, enabled: true, editable: true })
    }
  });

  const result = await evaluateLocatorDynamically(page, {
    path: 'operation.inputs[0].locator',
    kind: 'input',
    locator: { value: 'page.getByRole("textbox", { name: "Prompt" })' }
  }, { timeout: 1000 });

  assert.equal(result.status, 'stable');
  assert.ok(result.score >= 80);
  assert.equal(result.checks.editable, true);
});

test('evaluateLocatorDynamically allows missing output before submit', async () => {
  const page = new FakePage({
    css: {
      '#output': new FakeLocator({ count: 0 })
    }
  });

  const result = await evaluateLocatorDynamically(page, {
    path: 'operation.outputs[0].locator',
    kind: 'output',
    locator: { value: 'page.locator("#output")' }
  });

  assert.equal(result.status, 'warning');
  assert.equal(result.score, 70);
  assert.equal(result.checks.beforeMissingAllowed, true);
});

test('evaluateLocatorDynamically records Playwright-style errors', async () => {
  const page = new FakePage({
    css: {
      '#bad': new FakeLocator({ error: new Error('Timeout 1000ms exceeded') })
    }
  });

  const result = await evaluateLocatorDynamically(page, {
    path: 'operation.submit.locator',
    kind: 'submit',
    locator: { value: 'page.locator("#bad")' }
  });

  assert.equal(result.status, 'unstable');
  assert.equal(result.score, 0);
  assert.match(result.error, /Timeout/);
});

test('validateInterfaceLocatorsDynamic and mergeDynamicLocatorValidation attach dynamic summaries', async () => {
  const page = new FakePage({
    role: {
      textbox: new FakeLocator({ count: 1, visible: true, enabled: true, editable: true }),
      button: new FakeLocator({ count: 1, visible: true, enabled: true })
    },
    css: {
      '#output': new FakeLocator({ count: 0 })
    }
  });
  const dynamic = await validateInterfaceLocatorsDynamic(plan(), page, {
    url: 'https://example.com/app',
    timeout: 1000
  });
  const merged = mergeDynamicLocatorValidation({
    schemaVersion: 'web-adapter-tools.locator-validation.v1',
    ok: true,
    locatorCount: 3,
    minScore: 80,
    averageScore: 85,
    results: [
      { path: 'operation.inputs[0].locator', stableScore: 90, status: 'stable' },
      { path: 'operation.submit.locator', stableScore: 90, status: 'stable' },
      { path: 'operation.outputs[0].locator', stableScore: 80, status: 'stable' }
    ]
  }, dynamic);

  assert.equal(dynamic.results.length, 3);
  assert.equal(merged.mode, 'static+dynamic');
  assert.equal(merged.dynamic.url, 'https://example.com/app');
  assert.equal(merged.results[0].dynamic.status, 'stable');
});

class FakePage {
  constructor({ role = {}, css = {} } = {}) {
    this.role = role;
    this.css = css;
  }

  getByRole(role) {
    return this.role[role] || new FakeLocator({ count: 0 });
  }

  locator(selector) {
    return this.css[selector] || new FakeLocator({ count: 0 });
  }
}

class FakeLocator {
  constructor({ count = 1, visible = false, enabled = false, editable = false, error = null } = {}) {
    this.valueCount = count;
    this.visible = visible;
    this.enabled = enabled;
    this.editable = editable;
    this.error = error;
  }

  first() {
    return this;
  }

  async count() {
    if (this.error) throw this.error;
    return this.valueCount;
  }

  async waitFor() {
    if (this.error) throw this.error;
  }

  async isVisible() {
    if (this.error) throw this.error;
    return this.visible;
  }

  async isEnabled() {
    if (this.error) throw this.error;
    return this.enabled;
  }

  async isEditable() {
    if (this.error) throw this.error;
    return this.editable;
  }
}
