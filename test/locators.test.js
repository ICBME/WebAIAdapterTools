import test from 'node:test';
import assert from 'node:assert/strict';
import { generateLocatorCandidates, inferRole } from '../src/locators.js';

test('locator generation prefers role and stable attributes', () => {
  const element = {
    tag: 'textarea',
    role: '',
    type: '',
    id: 'prompt',
    placeholder: 'Ask anything',
    ariaLabel: '',
    labelText: 'Message',
    text: '',
    attributes: { 'data-testid': 'composer-input' },
    cssPath: 'form > textarea'
  };

  assert.equal(inferRole(element), 'textbox');
  const candidates = generateLocatorCandidates(element).map(c => c.value);
  assert.equal(candidates[0], `page.locator('[data-testid="composer-input"]')`);
  assert.ok(candidates.includes(`page.getByRole("textbox", { name: "Message" })`));
  assert.ok(candidates.includes(`page.locator('[placeholder="Ask anything"]')`));
  assert.ok(candidates.includes(`page.locator('#prompt')`));
});
