import { sanitizeUrl, summarizeUrlList } from './url.js';
import { createHash } from 'node:crypto';

const DEFAULT_SCHEMA_MAX_BYTES = 128 * 1024;
const JSON_CONTENT_PATTERN = /\b(application\/json|[^;\s]+\/[^;\s]+\+json)\b/i;
const SSE_CONTENT_PATTERN = /\btext\/event-stream\b/i;
const TEXT_CONTENT_PATTERN = /\b(text\/plain|application\/x-ndjson)\b/i;

function compact(value, max = 160) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function sha256(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}

function valueType(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function primitiveShape(value) {
  const type = valueType(value);
  const shape = { type };
  if (type === 'string') {
    shape.length = value.length;
    shape.hash = sha256(value);
  } else if (type === 'number') {
    shape.numberKind = Number.isInteger(value) ? 'integer' : 'float';
  } else if (type === 'boolean') {
    shape.boolean = true;
  }
  return shape;
}

function mergeTypes(existing, next) {
  const values = new Set();
  for (const value of Array.isArray(existing) ? existing : [existing]) {
    if (value) values.add(value);
  }
  for (const value of Array.isArray(next) ? next : [next]) {
    if (value) values.add(value);
  }
  return values.size === 1 ? Array.from(values)[0] : Array.from(values).sort();
}

function addField(fields, path, value) {
  const key = path || '$';
  const shape = primitiveShape(value);
  const existing = fields.get(key);
  if (existing) {
    existing.type = mergeTypes(existing.type, shape.type);
    existing.count += 1;
    if (shape.length !== undefined) {
      existing.length = existing.length || { min: shape.length, max: shape.length };
      existing.length.min = Math.min(existing.length.min, shape.length);
      existing.length.max = Math.max(existing.length.max, shape.length);
    }
    return;
  }
  const item = { path: key, type: shape.type, count: 1 };
  if (shape.length !== undefined) item.length = { min: shape.length, max: shape.length };
  if (shape.numberKind) item.numberKind = shape.numberKind;
  fields.set(key, item);
}

function walkJson(value, fields, path = '$', depth = 0, limits = {}) {
  const maxDepth = limits.maxDepth || 8;
  const maxFields = limits.maxFields || 200;
  if (fields.size >= maxFields) return;
  addField(fields, path, value);
  if (depth >= maxDepth || value === null) return;

  if (Array.isArray(value)) {
    const sample = value.slice(0, limits.maxArrayItems || 6);
    for (const item of sample) {
      walkJson(item, fields, `${path}[]`, depth + 1, limits);
      if (fields.size >= maxFields) break;
    }
    return;
  }

  if (typeof value === 'object') {
    for (const key of Object.keys(value).sort()) {
      const safeKey = /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key) ? `.${key}` : `[${JSON.stringify(key)}]`;
      walkJson(value[key], fields, `${path}${safeKey}`, depth + 1, limits);
      if (fields.size >= maxFields) break;
    }
  }
}

function summarizeJson(value, limits = {}) {
  const fields = new Map();
  walkJson(value, fields, '$', 0, limits);
  return {
    format: 'json',
    rootType: valueType(value),
    fields: Array.from(fields.values()).sort((a, b) => a.path.localeCompare(b.path))
  };
}

function parseJsonPayload(text) {
  const trimmed = String(text || '').trim();
  if (!trimmed) return null;
  return JSON.parse(trimmed);
}

function summarizeSse(text, limits = {}) {
  const maxEvents = limits.maxSseEvents || 20;
  const lines = String(text || '').split(/\r?\n/);
  const eventTypes = new Set();
  const dataJsonFields = new Map();
  let dataLineCount = 0;
  let jsonDataCount = 0;
  let doneCount = 0;

  for (const line of lines) {
    if (line.startsWith('event:')) {
      eventTypes.add(compact(line.slice('event:'.length), 80));
    }
    if (!line.startsWith('data:')) continue;
    dataLineCount += 1;
    if (dataLineCount > maxEvents) break;
    const data = line.slice('data:'.length).trim();
    if (data === '[DONE]') {
      doneCount += 1;
      continue;
    }
    try {
      const parsed = JSON.parse(data);
      jsonDataCount += 1;
      walkJson(parsed, dataJsonFields, '$', 0, limits);
    } catch {
      // Non-JSON SSE data is intentionally not stored.
    }
  }

  return {
    format: 'sse',
    eventTypes: Array.from(eventTypes).sort(),
    dataLineCount,
    jsonDataCount,
    doneCount,
    dataJsonFields: Array.from(dataJsonFields.values()).sort((a, b) => a.path.localeCompare(b.path))
  };
}

function summarizeNdjson(text, limits = {}) {
  const fields = new Map();
  let jsonLineCount = 0;
  for (const line of String(text || '').split(/\r?\n/).slice(0, limits.maxNdjsonLines || 20)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      walkJson(JSON.parse(trimmed), fields, '$', 0, limits);
      jsonLineCount += 1;
    } catch {
      // Ignore non-JSON lines.
    }
  }
  return {
    format: 'ndjson',
    jsonLineCount,
    fields: Array.from(fields.values()).sort((a, b) => a.path.localeCompare(b.path))
  };
}

function schemaForText(text, contentType = '', options = {}) {
  const raw = String(text || '');
  const maxBytes = options.maxSchemaBytes || DEFAULT_SCHEMA_MAX_BYTES;
  const byteLength = Buffer.byteLength(raw);
  const base = {
    contentType: compact(contentType, 120),
    byteLength,
    truncated: byteLength > maxBytes,
    hash: sha256(raw)
  };
  const sliced = byteLength > maxBytes ? raw.slice(0, maxBytes) : raw;

  try {
    if (SSE_CONTENT_PATTERN.test(contentType)) {
      return { ...base, ...summarizeSse(sliced, options) };
    }
    if (JSON_CONTENT_PATTERN.test(contentType)) {
      return { ...base, ...summarizeJson(parseJsonPayload(sliced), options) };
    }
    if (TEXT_CONTENT_PATTERN.test(contentType)) {
      const ndjson = summarizeNdjson(sliced, options);
      return { ...base, ...(ndjson.jsonLineCount ? ndjson : { format: 'text', lineCount: sliced.split(/\r?\n/).length }) };
    }
  } catch (error) {
    return { ...base, format: 'unparsed', parseError: compact(error.message, 120) };
  }
  return null;
}

function responseContentType(response) {
  try {
    return response.headers()?.['content-type'] || '';
  } catch {
    return '';
  }
}

function requestContentType(request) {
  try {
    return request.headers()?.['content-type'] || '';
  } catch {
    return '';
  }
}

export function attachNetworkRecorder(page, options = {}) {
  const maxEntries = options.maxEntries || 500;
  const captureSchema = Boolean(options.captureSchema || options.networkSchema);
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
      failure: null,
      schemaCapture: captureSchema ? {
        enabled: true,
        policy: 'structure-only',
        note: 'Values, headers, cookies, auth data, and query values are not stored.'
      } : undefined
    };
    if (captureSchema) {
      const postData = typeof request.postData === 'function' ? request.postData() : '';
      const contentType = requestContentType(request);
      const schema = postData ? schemaForText(postData, contentType, options) : null;
      if (schema) entry.requestSchema = schema;
    }
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
      if (captureSchema) {
        const contentType = responseContentType(response);
        if (JSON_CONTENT_PATTERN.test(contentType) || SSE_CONTENT_PATTERN.test(contentType) || TEXT_CONTENT_PATTERN.test(contentType)) {
          response.text()
            .then(text => {
              const schema = schemaForText(text, contentType, options);
              if (schema) entry.responseSchema = schema;
            })
            .catch(error => {
              entry.responseSchema = {
                contentType: compact(contentType, 120),
                format: 'unavailable',
                error: compact(error.message, 120)
              };
            });
        }
      }
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
