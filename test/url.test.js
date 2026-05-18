import test from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeUrl } from '../src/url.js';

test('sanitizeUrl keeps query keys but removes values', () => {
  const result = sanitizeUrl('https://example.com/app?token=secret&prompt=hello&token=again#section');
  assert.equal(result.origin, 'https://example.com');
  assert.equal(result.path, '/app');
  assert.deepEqual(result.queryKeys, ['prompt', 'token']);
  assert.equal(result.hasHash, true);
  assert.equal(result.display, 'https://example.com/app?prompt=...&token=...#...');
  assert.doesNotMatch(JSON.stringify(result), /secret|hello|again/);
});
