import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { attachNetworkRecorder } from '../src/networkRecorder.js';

function fakeRequest({
  method = 'POST',
  url = 'https://example.com/api/chat?token=secret',
  resourceType = 'fetch',
  headers = { 'content-type': 'application/json', authorization: 'Bearer secret' },
  postData = '{"prompt":"secret prompt","count":2}'
} = {}) {
  return {
    method: () => method,
    url: () => url,
    resourceType: () => resourceType,
    headers: () => headers,
    postData: () => postData
  };
}

function fakeResponse(request, {
  status = 200,
  headers = { 'content-type': 'text/event-stream' },
  body = 'event: message\ndata: {"message":{"content":"secret answer"},"done":false}\ndata: [DONE]\n'
} = {}) {
  return {
    request: () => request,
    status: () => status,
    headers: () => headers,
    text: async () => body
  };
}

test('network schema capture stores structure without raw values or sensitive headers', async () => {
  const page = new EventEmitter();
  const recorder = attachNetworkRecorder(page, { captureSchema: true });
  const request = fakeRequest();
  page.emit('request', request);
  page.emit('response', fakeResponse(request));
  await new Promise(resolve => setTimeout(resolve, 10));

  const summary = recorder.getSummary();
  assert.equal(summary.requests.length, 1);
  const entry = summary.requests[0];
  assert.equal(entry.url.display, 'https://example.com/api/chat?token=...');
  assert.equal(entry.schemaCapture.policy, 'structure-only');
  assert.equal(entry.requestSchema.format, 'json');
  assert.equal(entry.responseSchema.format, 'sse');
  assert.equal(entry.requestSchema.fields.some(field => field.path === '$.prompt' && field.type === 'string'), true);
  assert.equal(entry.responseSchema.dataJsonFields.some(field => field.path === '$.message.content'), true);

  const serialized = JSON.stringify(entry);
  assert.equal(serialized.includes('secret prompt'), false);
  assert.equal(serialized.includes('secret answer'), false);
  assert.equal(serialized.includes('Bearer secret'), false);
  assert.equal(serialized.includes('authorization'), false);
});

test('network schema capture is disabled by default', () => {
  const page = new EventEmitter();
  const recorder = attachNetworkRecorder(page);
  const request = fakeRequest();
  page.emit('request', request);

  const entry = recorder.getSummary().requests[0];
  assert.equal(entry.requestSchema, undefined);
  assert.equal(entry.schemaCapture, undefined);
});
