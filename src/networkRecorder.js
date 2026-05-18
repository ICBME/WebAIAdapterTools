import { sanitizeUrl, summarizeUrlList } from './url.js';

export function attachNetworkRecorder(page, options = {}) {
  const maxEntries = options.maxEntries || 500;
  const startedAt = Date.now();
  const entries = [];
  const byRequest = new WeakMap();
  let nextId = 1;

  function addEntry(request) {
    const entry = {
      id: nextId++,
      startedMs: Date.now() - startedAt,
      method: request.method(),
      url: sanitizeUrl(request.url()),
      resourceType: request.resourceType(),
      status: null,
      failure: null
    };
    byRequest.set(request, entry);
    entries.push(entry);
    if (entries.length > maxEntries) entries.shift();
    return entry;
  }

  page.on('request', request => {
    addEntry(request);
  });

  page.on('response', response => {
    const entry = byRequest.get(response.request());
    if (entry) {
      entry.status = response.status();
      entry.endedMs = Date.now() - startedAt;
    }
  });

  page.on('requestfailed', request => {
    const entry = byRequest.get(request) || addEntry(request);
    entry.failure = request.failure()?.errorText || 'request failed';
    entry.endedMs = Date.now() - startedAt;
  });

  function getSummary() {
    return {
      summary: summarizeUrlList(entries),
      requests: entries
    };
  }

  function reset() {
    entries.length = 0;
    nextId = 1;
  }

  return {
    reset,
    getSummary() {
      return getSummary();
    }
  };
}
