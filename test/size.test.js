import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_WINDOW_SIZE, parseWindowSize } from '../src/size.js';

test('parseWindowSize accepts WIDTHxHEIGHT', () => {
  assert.deepEqual(parseWindowSize('1366x768'), { width: 1366, height: 768 });
  assert.deepEqual(parseWindowSize(), DEFAULT_WINDOW_SIZE);
});

test('parseWindowSize rejects invalid values', () => {
  assert.throws(() => parseWindowSize('1366*768'), /WIDTHxHEIGHT/);
  assert.throws(() => parseWindowSize('320x200'), /at least/);
});
