import fs from 'node:fs/promises';
import path from 'node:path';
import { generateLocatorCandidates } from './locators.js';

const JSON_SPACE = 2;
const ACTION_RESOURCE_TYPES = new Set(['xhr', 'fetch', 'document']);
const TRACKING_PATTERN = /\b(telemetry|analytics|beacon|collect|events?|log|lsp|fd\/ls|pixel|metrics|rewards?|identity|idtoken)\b/i;
const ACTION_ENDPOINT_PATTERN = /\b(api|chat|completion|conversation|message|search|query|generate|graphql|rpc|stream|submit)\b/i;

function jsString(value) {
  return JSON.stringify(String(value || ''));
}

function compact(value, max = 160) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function slugName(value, fallback) {
  const cleaned = compact(value, 80).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  return cleaned || fallback;
}

function firstLocator(candidates) {
  return candidates?.[0] || null;
}

function locatorFromTarget(target) {
  if (!target) return null;
  const candidates = generateLocatorCandidates({
    tag: target.tag || '',
    role: target.role || '',
    type: target.type || '',
    id: /^el_\d+$/.test(String(target.id || '')) ? '' : target.id || '',
    name: target.name || '',
    className: target.className || '',
    text: target.text || '',
    placeholder: target.placeholder || '',
    ariaLabel: target.ariaLabel || '',
    labelText: '',
    href: target.href || '',
    cssPath: target.cssPath || '',
    attributes: {}
  });
  return firstLocator(candidates);
}

function locatorFromRecommendation(item) {
  return firstLocator(item?.locatorCandidates);
}

function textForElement(element) {
  return compact(element?.ariaLabel || element?.placeholder || element?.labelText || element?.text || element?.id || element?.tag || '');
}

function inferTextInputName(source, pageUrl) {
  const text = textForElement(source?.element || source?.target || source);
  const queryKeys = pageUrl?.queryKeys || [];
  if (/\b(search|query)\b|搜索/i.test(`${text} ${pageUrl?.path || ''}`) || queryKeys.includes('q')) return 'query';
  if (/\b(prompt|message|ask|question|chat)\b|提问|消息|描述/i.test(text)) return 'prompt';
  return slugName(text, 'input');
}

function interactionRecommendations(bundle) {
  return bundle.beforeRecommendations || bundle.activeRecommendations || {};
}

function mergeLastInputEvents(events) {
  const map = new Map();
  for (const event of events || []) {
    if (!['input', 'input-snapshot', 'change'].includes(event.type)) continue;
    if (!event.input || event.input.redacted) continue;
    if (!event.input.length && !event.input.preview) continue;
    const key = event.target?.cssPath || event.target?.id || event.target?.ariaLabel || `event-${event.seq}`;
    map.set(key, event);
  }
  return Array.from(map.values()).sort((a, b) => a.seq - b.seq);
}

function inferInputs(bundle) {
  const events = mergeLastInputEvents(bundle.actionEvents?.events || []);
  if (events.length) {
    return events.map((event, index) => ({
      name: inferTextInputName(event, bundle.activePage?.url),
      type: 'string',
      required: true,
      source: 'recorded-action',
      preview: event.input?.preview || '',
      length: event.input?.length || 0,
      redacted: Boolean(event.input?.redacted),
      locator: locatorFromTarget(event.target),
      evidence: {
        eventSeq: event.seq,
        eventType: event.type,
        target: event.target || null
      },
      order: index + 1
    }));
  }

  return (interactionRecommendations(bundle).inputs || []).slice(0, 1).map((item, index) => ({
    name: inferTextInputName(item, bundle.activePage?.url),
    type: 'string',
    required: index === 0,
    source: 'recommendation',
    preview: '',
    locator: locatorFromRecommendation(item),
    evidence: {
      elementId: item.elementId,
      score: item.score,
      reasons: item.reasons || []
    },
    order: index + 1
  }));
}

function inferUploads(bundle) {
  const fileEvents = (bundle.actionEvents?.events || []).filter(event => event.type === 'file-change');
  if (fileEvents.length) {
    return fileEvents.map((event, index) => ({
      name: 'file',
      type: 'file',
      required: true,
      source: 'recorded-action',
      locator: locatorFromTarget(event.target),
      acceptedExamples: (event.files || []).map(file => ({
        name: file.name,
        type: file.type,
        size: file.size
      })),
      evidence: {
        eventSeq: event.seq,
        target: event.target || null
      },
      order: index + 1
    }));
  }

  const textInputs = interactionRecommendations(bundle).inputs || [];
  if (textInputs.length) return [];

  return (interactionRecommendations(bundle).uploads || []).slice(0, 1).map((item, index) => ({
    name: 'file',
    type: 'file',
    required: false,
    source: 'recommendation',
    locator: locatorFromRecommendation(item),
    acceptedExamples: [],
    evidence: {
      elementId: item.elementId,
      score: item.score,
      reasons: item.reasons || []
    },
    order: index + 1
  }));
}

function inferSubmit(bundle, inputs) {
  const events = bundle.actionEvents?.events || [];
  const submitEvent = [...events].reverse().find(event => event.type === 'submit');
  const clickEvent = [...events].reverse().find(event => event.type === 'click');
  const enterEvent = [...events].reverse().find(event => event.type === 'key' && event.key?.key === 'Enter');

  if (submitEvent?.submitter) {
    return {
      action: 'click',
      source: 'recorded-submit',
      locator: locatorFromTarget(submitEvent.submitter),
      evidence: { eventSeq: submitEvent.seq, target: submitEvent.submitter }
    };
  }
  if (enterEvent) {
    return {
      action: 'press',
      key: 'Enter',
      source: submitEvent ? 'recorded-submit-key' : 'recorded-key',
      locator: locatorFromTarget(enterEvent.target),
      evidence: {
        eventSeq: enterEvent.seq,
        submitSeq: submitEvent?.seq || null,
        target: enterEvent.target
      }
    };
  }
  if (clickEvent) {
    return {
      action: 'click',
      source: 'recorded-click',
      locator: locatorFromTarget(clickEvent.target),
      evidence: { eventSeq: clickEvent.seq, target: clickEvent.target }
    };
  }

  const candidate = interactionRecommendations(bundle).submits?.[0];
  if (!candidate || candidate.score < 60) {
    const input = inputs[0];
    if (!input) return null;
    return {
      action: 'press',
      key: 'Enter',
      source: 'input-enter-fallback',
      locator: input.locator,
      evidence: {
        reason: candidate ? `Top submit recommendation score ${candidate.score} is below confidence threshold.` : 'No submit recommendation.',
        inputName: input.name
      }
    };
  }
  return {
    action: 'click',
    source: 'recommendation',
    locator: locatorFromRecommendation(candidate),
    evidence: {
      elementId: candidate.elementId,
      score: candidate.score,
      reasons: candidate.reasons || []
    }
  };
}

function outputFromChangedElement(change) {
  const element = change?.after || change;
  if (!element || !compact(element.text)) return null;
  return {
    name: 'result',
    type: 'text',
    source: change?.after ? 'dom-text-change' : 'dom-added',
    locator: locatorFromTarget(element),
    preview: compact(element.text, 220),
    evidence: element
  };
}

function inferOutputs(bundle) {
  const diff = bundle.actionDiff || {};
  const changed = (diff.textChanged || [])
    .filter(change => isLikelyOutputElement(change?.after))
    .map(outputFromChangedElement)
    .filter(Boolean);
  if (changed.length) return changed.slice(0, 3);

  const added = (diff.addedElements || [])
    .filter(isLikelyOutputElement)
    .map(outputFromChangedElement)
    .filter(Boolean);
  if (added.length) return added.slice(0, 3);

  const recommended = (bundle.activeRecommendations?.outputs || [])
    .filter(item => compact(item.element?.text).length >= 20 || item.score >= 60)
    .slice(0, 2);
  return recommended.map(item => ({
    name: 'result',
    type: 'text',
    source: 'recommendation',
    locator: locatorFromRecommendation(item),
    preview: textForElement(item.element),
    evidence: {
      elementId: item.elementId,
      score: item.score,
      reasons: item.reasons || []
    }
  }));
}

function isLikelyOutputElement(element) {
  if (!element) return false;
  const categories = element.categories || [];
  const text = compact(element.text);
  if (!text) return false;
  if (categories.includes('button') || categories.includes('link') || categories.includes('input') || categories.includes('form')) return false;
  return categories.includes('output') || text.length >= 20;
}

function uniqueOutputNames(outputs) {
  return outputs.map((output, index) => ({
    ...output,
    name: index === 0 ? output.name : `${output.name}_${index + 1}`
  }));
}

function rankOutputs(outputs) {
  return outputs
    .map((output, index) => ({ output, index }))
    .sort((a, b) => {
      const confidenceDelta = (b.output.locator?.confidence || 0) - (a.output.locator?.confidence || 0);
      if (confidenceDelta) return confidenceDelta;
      return a.index - b.index;
    })
    .map(item => item.output);
}

function endpointKey(request) {
  return [
    request.method || 'GET',
    request.url?.origin || '',
    request.url?.path || '',
    request.resourceType || ''
  ].join(' ');
}

function scoreEndpoint(group, finalOrigin) {
  const sample = group.sample;
  const endpointText = `${sample.url?.origin || ''} ${sample.url?.path || ''} ${(sample.url?.queryKeys || []).join(' ')}`;
  const actionLike = ACTION_ENDPOINT_PATTERN.test(endpointText);
  let score = 0;
  if (sample.method === 'POST') score += 30;
  if (['xhr', 'fetch'].includes(sample.resourceType)) score += 25;
  if (sample.resourceType === 'document') score += 10;
  if (sample.url?.origin && sample.url.origin === finalOrigin) score += 10;
  if (actionLike) score += 25;
  if (!actionLike) score -= 25;
  if (sample.url?.queryKeys?.includes('q') || sample.url?.queryKeys?.includes('query') || sample.url?.queryKeys?.includes('qry')) score += 12;
  if (sample.url?.queryKeys?.length) score += 6;
  if (TRACKING_PATTERN.test(endpointText)) score -= 35;
  if (sample.status && sample.status >= 200 && sample.status < 400) score += 8;
  if (group.count > 1) score += Math.min(10, group.count);
  if (group.failed) score -= 20;
  return Math.max(0, Math.min(100, score));
}

function inferNetworkCandidates(bundle) {
  const requests = bundle.actionNetwork?.requests || [];
  const groups = new Map();
  for (const request of requests) {
    if (!ACTION_RESOURCE_TYPES.has(request.resourceType)) continue;
    const key = endpointKey(request);
    const current = groups.get(key) || {
      method: request.method || '',
      resourceType: request.resourceType || '',
      url: request.url || null,
      count: 0,
      statuses: new Set(),
      failed: 0,
      sample: request
    };
    current.count += 1;
    if (request.status) current.statuses.add(request.status);
    if (request.failure) current.failed += 1;
    groups.set(key, current);
  }

  const finalOrigin = bundle.activePage?.url?.origin || bundle.profile?.capture?.finalUrl?.origin || '';
  return Array.from(groups.values())
    .map(group => ({
      method: group.method,
      resourceType: group.resourceType,
      url: group.url,
      count: group.count,
      statuses: Array.from(group.statuses).sort((a, b) => a - b),
      failed: group.failed,
      score: scoreEndpoint(group, finalOrigin),
      evidence: 'Network data is sanitized: headers, request bodies, response bodies, cookies, and query values were not captured.'
    }))
    .filter(item => item.score > 0)
    .sort((a, b) => b.score - a.score || b.count - a.count)
    .slice(0, 12);
}

function inferOperationName(bundle, inputs) {
  const page = bundle.activePage || {};
  const text = `${page.title || ''} ${page.url?.path || ''} ${(page.url?.queryKeys || []).join(' ')}`;
  if (/\bsearch\b|搜索/i.test(text) || inputs.some(input => input.name === 'query')) return 'search';
  if (/\bchat|message|assistant|conversation\b|聊天|消息/i.test(text)) return 'send_message';
  if (/\bgenerate|create|image|completion\b|生成|创建/i.test(text)) return 'generate';
  return 'perform_action';
}

function buildSteps(bundle, inputs, uploads, submit, outputs) {
  const steps = [];
  const startUrl = bundle.actionDiff?.beforeUrl || bundle.profile?.capture?.finalUrl || bundle.profile?.capture?.initialUrl || null;
  if (startUrl) {
    steps.push({ type: 'goto', url: startUrl, source: 'capture' });
  }
  for (const input of inputs) {
    steps.push({
      type: 'fill',
      name: input.name,
      locator: input.locator,
      valueFrom: `inputs.${input.name}`,
      source: input.source
    });
  }
  for (const upload of uploads) {
    steps.push({
      type: 'upload',
      name: upload.name,
      locator: upload.locator,
      valueFrom: `inputs.${upload.name}`,
      source: upload.source
    });
  }
  if (submit) {
    steps.push({
      type: submit.action,
      locator: submit.locator,
      key: submit.key,
      source: submit.source
    });
  }
  steps.push({
    type: 'wait',
    condition: outputs.length ? 'output-change' : 'networkidle',
    locator: outputs[0]?.locator || null,
    source: outputs.length ? outputs[0].source : 'fallback'
  });
  return steps;
}

function confidenceScore({ inputs, uploads, submit, outputs, networkCandidates, bundle }) {
  let score = 30;
  if ((bundle.actionEvents?.events || []).length) score += 20;
  if (inputs.length) score += 18;
  if (uploads.length) score += 5;
  if (submit) score += 14;
  if (outputs.length) score += 14;
  if (networkCandidates.length) score += 8;
  if (bundle.actionEvents && !(bundle.actionEvents.events || []).length) score -= 15;
  return Math.max(0, Math.min(100, score));
}

function warningsFor(bundle, inputs, submit, outputs) {
  const warnings = [];
  if (bundle.actionEvents && !(bundle.actionEvents.events || []).length) {
    warnings.push('No DOM action events were recorded; selectors are inferred from recommendations and DOM diff only.');
  }
  if (!inputs.length) warnings.push('No input field could be inferred.');
  if (!submit) warnings.push('No submit action could be inferred.');
  if (!outputs.length) warnings.push('No output container could be inferred.');
  if (!bundle.actionNetwork?.requests?.length) warnings.push('No action network requests were captured.');
  warnings.push('Network capture is intentionally sanitized and cannot reproduce private HTTP APIs without an additional opt-in body/header capture mode.');
  return warnings;
}

export function buildInterfacePlan(bundle) {
  const inputs = inferInputs(bundle);
  const uploads = inferUploads(bundle);
  const submit = inferSubmit(bundle, inputs);
  const outputs = uniqueOutputNames(rankOutputs(inferOutputs(bundle)));
  const networkCandidates = inferNetworkCandidates(bundle);
  const operationName = inferOperationName(bundle, inputs);
  const steps = buildSteps(bundle, inputs, uploads, submit, outputs);
  const confidence = confidenceScore({ inputs, uploads, submit, outputs, networkCandidates, bundle });

  return {
    schemaVersion: 'web-adapter-tools.interface-plan.v1',
    source: {
      capturedAt: bundle.profile?.capture?.capturedAt || null,
      initialUrl: bundle.profile?.capture?.initialUrl || null,
      finalUrl: bundle.activePage?.url || bundle.profile?.capture?.finalUrl || null,
      actionMode: bundle.actionEvents?.mode || null
    },
    operation: {
      name: operationName,
      transport: 'browser',
      confidence,
      inputs: [...inputs, ...uploads],
      outputs,
      submit,
      steps
    },
    networkCandidates,
    warnings: warningsFor(bundle, inputs, submit, outputs),
    evidence: {
      eventCount: bundle.actionEvents?.events?.length || 0,
      actionNetworkRequestCount: bundle.actionNetwork?.requests?.length || 0,
      diffCounts: bundle.actionDiff?.counts || {},
      recommendationCounts: {
        inputs: bundle.activeRecommendations?.inputs?.length || 0,
        uploads: bundle.activeRecommendations?.uploads?.length || 0,
        submits: bundle.activeRecommendations?.submits?.length || 0,
        outputs: bundle.activeRecommendations?.outputs?.length || 0
      }
    }
  };
}

async function readJson(filePath, fallback = null) {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw error;
  }
}

export async function loadCaptureBundle(captureDir) {
  const profile = await readJson(path.join(captureDir, 'profile.json'));
  if (!profile) throw new Error(`Missing profile.json in ${captureDir}`);
  const files = profile.files || {};
  const activePage = await readJson(path.join(captureDir, files.page || 'pages/current.json'), profile.page || null);
  const activeRecommendations = await readJson(path.join(captureDir, files.recommendations || 'recommendations/current.json'), profile.recommendations || null);
  const beforeRecommendations = files.beforeRecommendations ? await readJson(path.join(captureDir, files.beforeRecommendations), null) : null;
  const actionEvents = files.actionEvents ? await readJson(path.join(captureDir, files.actionEvents), null) : null;
  const actionDiff = files.actionDiff ? await readJson(path.join(captureDir, files.actionDiff), null) : null;
  const actionNetwork = files.actionNetwork ? await readJson(path.join(captureDir, files.actionNetwork), { summary: {}, requests: [] }) : null;

  return {
    profile,
    activePage,
    activeRecommendations,
    beforeRecommendations,
    actionEvents,
    actionDiff,
    actionNetwork
  };
}

export function renderInterfaceMarkdown(plan) {
  const lines = [];
  lines.push(`# ${plan.operation.name}`);
  lines.push('');
  lines.push(`Transport: ${plan.operation.transport}`);
  lines.push(`Confidence: ${plan.operation.confidence}/100`);
  lines.push('');
  lines.push('## Inputs');
  if (plan.operation.inputs.length) {
    for (const input of plan.operation.inputs) {
      lines.push(`- \`${input.name}\` (${input.type}, ${input.required ? 'required' : 'optional'}): ${input.locator?.value || 'no locator'}`);
    }
  } else {
    lines.push('- None inferred.');
  }
  lines.push('');
  lines.push('## Steps');
  for (const step of plan.operation.steps) {
    const detail = step.valueFrom || step.key || step.locator?.value || step.condition || step.url?.display || '';
    lines.push(`- ${step.type}: ${detail}`);
  }
  lines.push('');
  lines.push('## Outputs');
  if (plan.operation.outputs.length) {
    for (const output of plan.operation.outputs) {
      lines.push(`- \`${output.name}\` (${output.type}): ${output.locator?.value || 'no locator'}`);
    }
  } else {
    lines.push('- None inferred.');
  }
  lines.push('');
  lines.push('## Network Candidates');
  if (plan.networkCandidates.length) {
    for (const candidate of plan.networkCandidates.slice(0, 8)) {
      lines.push(`- ${candidate.method} ${candidate.url?.display || ''} (${candidate.resourceType}, score ${candidate.score})`);
    }
  } else {
    lines.push('- None inferred.');
  }
  lines.push('');
  lines.push('## Warnings');
  for (const warning of plan.warnings) lines.push(`- ${warning}`);
  lines.push('');
  return lines.join('\n');
}

export async function writeInterfaceArtifacts(plan, outDir) {
  await fs.mkdir(outDir, { recursive: true });
  await fs.writeFile(path.join(outDir, 'interface.json'), JSON.stringify(plan, null, JSON_SPACE), 'utf8');
  await fs.writeFile(path.join(outDir, 'interface.md'), renderInterfaceMarkdown(plan), 'utf8');
}
