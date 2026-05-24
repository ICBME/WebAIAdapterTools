import fs from 'node:fs/promises';
import path from 'node:path';
import { buildInterfacePlan, loadCaptureBundle } from './interfaceAnalyzer.js';
import {
  applyLocatorValidation,
  loadLocatorValidationInputs,
  validateInterfaceLocators,
  writeLocatorValidationArtifacts
} from './locatorValidator.js';

const DEFAULT_MODEL_ID = 'generated-browser-text';
const TARGET_KINDS = new Set(['webai2api', 'web2web-sidecar']);
const SUPPORTED_TEMPLATES = new Set([
  'search_text',
  'dom_text',
  'conversation_text',
  'sse_text',
  'upload_text',
  'download_image'
]);
const LOCATOR_PREFIXES = [
  'page.getByRole(',
  'page.locator(',
  'page.getByText(',
  'page.getByLabel(',
  'page.getByPlaceholder(',
  'page.getByAltText(',
  'page.getByTitle(',
  'page.getByTestId('
];
const DEFAULT_LOCATOR_SCORE = 70;

function compact(value, max = 120) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function jsString(value) {
  return JSON.stringify(String(value || ''));
}

function sanitizeIdentifier(value, fallback = 'generated_adapter') {
  const cleaned = String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return /^[a-z][a-z0-9_]*$/.test(cleaned) ? cleaned : fallback;
}

function assertSafeLocatorExpression(expression, label) {
  const value = String(expression || '').trim();
  if (!value) throw new Error(`${label} 缺少 locator 表达式`);
  if (!LOCATOR_PREFIXES.some(prefix => value.startsWith(prefix))) {
    throw new Error(`${label} locator 不在允许的 Playwright locator 白名单内: ${value}`);
  }
  if (/[\n\r;`]|\b(?:eval|Function|import|require|process|globalThis|window|document)\b/.test(value)) {
    throw new Error(`${label} locator 包含不允许的代码片段: ${value}`);
  }
  return value;
}

function urlWithoutRedactedQuery(url) {
  if (!url?.origin) return '';
  return `${url.origin}${url.path || '/'}`;
}

function inferTargetUrl(plan) {
  const gotoStep = plan.operation?.steps?.find(step => step.type === 'goto' && step.url?.origin);
  return urlWithoutRedactedQuery(gotoStep?.url) ||
    urlWithoutRedactedQuery(plan.source?.initialUrl) ||
    urlWithoutRedactedQuery(plan.source?.finalUrl);
}

function inferTemplate(plan, requested) {
  if (requested) return requested;
  if (plan.operation?.template) return plan.operation.template;
  if (plan.operation?.name === 'search') return 'search_text';
  if (plan.operation?.name === 'send_message') return 'conversation_text';
  return 'dom_text';
}

function validatePlan(plan, options = {}) {
  if (!['web-adapter-tools.interface-plan.v1', 'web-adapter-tools.interface-plan.v2'].includes(plan?.schemaVersion)) {
    throw new Error('interface.json schemaVersion 不正确');
  }
  if (plan.operation?.transport !== 'browser') {
    throw new Error('第一版生成器仅支持 browser transport');
  }
  const template = inferTemplate(plan, options.template);
  if (!SUPPORTED_TEMPLATES.has(template)) {
    throw new Error(`不支持的模板: ${template}. 可选值: ${Array.from(SUPPORTED_TEMPLATES).join(', ')}`);
  }
  const input = plan.operation?.inputs?.find(item => item.type === 'string');
  const output = plan.operation?.outputs?.find(item => item.type === 'text' || item.type === 'image') ||
    plan.operation?.extractors?.find(item => item.type === 'text' || item.type === 'image');
  if (!input) throw new Error('interface plan 缺少文本输入');
  if (!output) throw new Error('interface plan 缺少输出提取器');
  if (!plan.operation?.submit) throw new Error('interface plan 缺少提交动作');
  return { template, input, output, submit: plan.operation.submit };
}

function locatorFunctionCode(expression) {
  return `page => ${expression}`;
}

function targetKind(options = {}) {
  const kind = options.targetKind || options.target || 'webai2api';
  if (!TARGET_KINDS.has(kind)) {
    throw new Error(`不支持的 adapter 目标: ${kind}. 可选值: ${Array.from(TARGET_KINDS).join(', ')}`);
  }
  return kind;
}

function submitBindingCode(submit, inputLocatorExpression) {
  if (submit.action === 'press') {
    const submitLocator = assertSafeLocatorExpression(submit.locator?.value || inputLocatorExpression, 'submit');
    const target = submitLocator === inputLocatorExpression ? 'input' : 'submit';
    const locatorLine = target === 'input' ? '' : `,\n            locator: ${locatorFunctionCode(submitLocator)}`;
    return `{
            action: 'press',
            target: ${jsString(target)},
            key: ${jsString(submit.key || 'Enter')}${locatorLine}
        }`;
  }

  if (submit.action === 'click') {
    const submitLocator = assertSafeLocatorExpression(submit.locator?.value, 'submit');
    const target = submitLocator === inputLocatorExpression ? 'input' : 'submit';
    const locatorLine = target === 'input' ? '' : `,\n            locator: ${locatorFunctionCode(submitLocator)}`;
    return `{
            action: 'click',
            target: ${jsString(target)}${locatorLine}
        }`;
  }

  throw new Error(`不支持的提交动作: ${submit.action}`);
}

function buildAdapterSpec(plan, options = {}) {
  const { template, input, output, submit } = validatePlan(plan, options);
  const uploads = (plan.operation?.inputs || []).filter(item => item.type === 'file');
  const adapterId = sanitizeIdentifier(options.id || `${plan.operation.name || 'generated'}_text`);
  const modelId = compact(options.model || DEFAULT_MODEL_ID, 80);
  const displayName = compact(options.displayName || adapterId.replace(/_/g, ' '), 120);
  const description = compact(options.description || `Generated from WebAdapterTools capture for ${plan.operation.name || 'browser action'}.`, 200);
  const targetUrl = options.targetUrl || inferTargetUrl(plan);

  if (!targetUrl) throw new Error('无法推断 targetUrl');

  const inputLocator = assertSafeLocatorExpression(input.locator?.value, 'input');
  const outputLocator = output.locator?.value ? assertSafeLocatorExpression(output.locator.value, 'output') : '';
  const uploadLocators = uploads
    .filter(upload => upload.locator?.value)
    .map(upload => ({
      ...upload,
      locatorExpression: assertSafeLocatorExpression(upload.locator.value, `upload:${upload.name || 'file'}`)
    }));
  const submitCode = submitBindingCode(submit, inputLocator);
  const modelType = template === 'download_image' ? 'image' : 'text';
  const imagePolicy = template === 'upload_text' ? 'optional' : template === 'download_image' ? 'forbidden' : 'forbidden';

  return {
    adapterId,
    description,
    displayName,
    input,
    inputLocator,
    modelId,
    output,
    outputLocator,
    submit,
    submitCode,
    imagePolicy,
    modelType,
    setupSteps: plan.operation?.setupSteps || [],
    targetUrl,
    template,
    uploadLocators,
    waitSignals: plan.operation?.waitSignals || [],
    extractors: plan.operation?.extractors || []
  };
}

function serializableSpec(spec) {
  return {
    id: spec.adapterId,
    template: spec.template,
    targetUrl: spec.targetUrl,
    models: [
      { id: spec.modelId, imagePolicy: spec.imagePolicy, type: spec.modelType }
    ],
    waitSignals: spec.waitSignals,
    extractors: spec.extractors,
    setupSteps: spec.setupSteps
  };
}

function uploadBindingCode(uploadLocators) {
  if (!uploadLocators.length) return '[]';
  return `[
${uploadLocators.map(upload => `            {
                name: ${jsString(upload.name || 'file')},
                required: ${upload.required ? 'true' : 'false'},
                locator: ${locatorFunctionCode(upload.locatorExpression)}
            }`).join(',\n')}
        ]`;
}

function buildWebAI2APISource(plan, options = {}) {
  const spec = buildAdapterSpec(plan, options);

  return `/**
 * @fileoverview Generated WebAI2API adapter: ${spec.adapterId}
 * @generated by WebAdapterTools
 */

import { runTemplate } from '../adapter_runtime/templateRunner.js';

const spec = {
    ...${JSON.stringify(serializableSpec(spec), null, 4)},
    bindings: {
        input: {
            name: ${jsString(spec.input.name || 'prompt')},
            valueFrom: 'prompt',
            locator: ${locatorFunctionCode(spec.inputLocator)}
        },
        uploads: ${uploadBindingCode(spec.uploadLocators)},
        submit: ${spec.submitCode},
        output: {
            extract: ${jsString(spec.output.extract || 'innerText')},
            locator: ${spec.outputLocator ? locatorFunctionCode(spec.outputLocator) : 'null'}
        }
    }
};

async function generate(context, prompt, paths, modelId, meta = {}) {
    return runTemplate(context, spec, { prompt, paths, modelId, meta });
}

export const manifest = {
    id: spec.id,
    displayName: ${jsString(spec.displayName)},
    description: ${jsString(spec.description)},
    getTargetUrl() {
        return spec.targetUrl;
    },
    models: spec.models,
    navigationHandlers: [],
    generate
};
`;
}

function sidecarSubmitCode(submit, inputLocatorExpression) {
  if (submit.action === 'press') {
    const submitLocator = assertSafeLocatorExpression(submit.locator?.value || inputLocatorExpression, 'submit');
    const target = submitLocator === inputLocatorExpression ? 'input' : 'submit';
    const locatorLine = target === 'input' ? '' : `\n        const submitTarget = first(${locatorFunctionCode(submitLocator)}(page));`;
    const targetExpr = target === 'input' ? 'input' : 'submitTarget';
    return `${locatorLine}
        await ${targetExpr}.press(${jsString(submit.key || 'Enter')});`;
  }

  if (submit.action === 'click') {
    const submitLocator = assertSafeLocatorExpression(submit.locator?.value, 'submit');
    const target = submitLocator === inputLocatorExpression ? 'input' : 'submit';
    const locatorLine = target === 'input' ? '' : `\n        const submitTarget = first(${locatorFunctionCode(submitLocator)}(page));`;
    const targetExpr = target === 'input' ? 'input' : 'submitTarget';
    return `${locatorLine}
        await safeClick(page, ${targetExpr}, { bias: 'button' });`;
  }

  throw new Error(`不支持的提交动作: ${submit.action}`);
}

function buildWeb2WebSidecarSource(plan, options = {}) {
  const spec = buildAdapterSpec(plan, options);
  const submitCode = sidecarSubmitCode(spec.submit, spec.inputLocator);

  return `/**
 * @fileoverview Generated WEB2WEB sidecar adapter: ${spec.adapterId}
 * @generated by WebAdapterTools
 */

import { gotoWithCheck, humanType, normalizeError, safeClick, sleep, uploadFilesViaChooser, waitForInput } from '../browser/actions.js';

const TARGET_URL = ${jsString(spec.targetUrl)};

const spec = {
  ...${JSON.stringify(serializableSpec(spec), null, 2)},
  targetUrl: TARGET_URL,
  bindings: {
    input: {
      locator: ${locatorFunctionCode(spec.inputLocator)}
    },
    uploads: ${uploadBindingCode(spec.uploadLocators).replace(/^/gm, '    ').trim()},
    output: {
      extract: ${jsString(spec.output.extract || 'innerText')},
      locator: ${spec.outputLocator ? locatorFunctionCode(spec.outputLocator) : 'null'}
    }
  }
};

function first(locator) {
  return typeof locator?.first === 'function' ? locator.first() : locator;
}

async function clearInput(page, input) {
  if (typeof input.fill === 'function') {
    await Promise.resolve(input.fill('')).catch(() => {});
    return;
  }
  const modifier = process.platform === 'darwin' ? 'Meta' : 'Control';
  await page.keyboard.down(modifier);
  await page.keyboard.press('A');
  await page.keyboard.up(modifier);
  await page.keyboard.press('Backspace');
}

async function extractOutput(locator, mode = 'innerText') {
  const target = first(locator);
  if (!target) return '';
  if (mode?.startsWith?.('attribute:')) return await target.getAttribute(mode.slice('attribute:'.length));
  if (mode === 'textContent') return await target.textContent();
  if (mode === 'inputValue') return await target.inputValue();
  return await target.innerText();
}

function matchesNetworkSignal(response, signal) {
  if (!signal?.url?.path && !signal?.url?.display) return false;
  const url = response.url();
  const method = response.request?.().method?.() || '';
  if (signal.method && method && method !== signal.method) return false;
  if (signal.status && response.status?.() !== signal.status) return false;
  const needle = signal.url.path || signal.url.display;
  return needle ? url.includes(needle) : true;
}

function prepareNetworkWaits(page, waitTimeout) {
  return (spec.waitSignals || [])
    .filter(signal => ['network-response', 'network-stream'].includes(signal.type))
    .slice(0, 2)
    .map(signal => page.waitForResponse(response => matchesNetworkSignal(response, signal), { timeout: waitTimeout })
      .catch(error => ({ error, signal })));
}

export async function preload(ctx, options = {}) {
  const { page, config = {}, logger = page.web2webLogger } = ctx;
  const waitTimeout = options.timeoutMs || config.preloadTimeoutMs || 60000;
  const log = logger?.child?.({ adapter: manifest.id }) || noopLogger;
  log.info('preload start', { targetUrl: spec.targetUrl, timeoutMs: waitTimeout });
  await gotoWithCheck(page, spec.targetUrl, { timeout: waitTimeout });
  const input = first(spec.bindings.input.locator(page));
  await waitForInput(page, input, { click: false, timeout: waitTimeout });
  log.info('preload complete');
}

export async function generate(ctx, req = {}) {
  const { page, logger = page.web2webLogger } = ctx;
  const waitTimeout = req.timeoutMs || 120000;
  const prompt = String(req.prompt || '').trim();
  const log = logger?.child?.({ adapter: manifest.id }) || noopLogger;

  if (!prompt) return { error: 'prompt is required', retryable: false };
  if (req.imagePaths?.length && !spec.bindings.uploads?.length) {
    return { error: 'generated sidecar adapter has no upload binding', retryable: false };
  }

  try {
    log.info('generate start', {
      targetUrl: spec.targetUrl,
      timeoutMs: waitTimeout,
      model: req.model,
      promptChars: prompt.length
    });
    await gotoWithCheck(page, spec.targetUrl, { timeout: waitTimeout });
    const input = first(spec.bindings.input.locator(page));
    await waitForInput(page, input, { click: false, timeout: waitTimeout });
    await safeClick(page, input, { bias: 'input' });
    await clearInput(page, input);
    if (req.imagePaths?.length) {
      const upload = spec.bindings.uploads[0];
      const uploadTarget = first(upload.locator(page));
      await uploadFilesViaChooser(page, uploadTarget, req.imagePaths);
    }
    await humanType(page, input, prompt);
    const networkWaits = prepareNetworkWaits(page, waitTimeout);
    ${submitCode}
    if (networkWaits.length) {
      await Promise.race([Promise.race(networkWaits), sleep(5000, 5000)]).catch(() => {});
    }

    const output = first(spec.bindings.output.locator(page));
    await output.waitFor({ state: 'visible', timeout: waitTimeout });
    await sleep(300, 600);
    const raw = (await extractOutput(output, spec.bindings.output.extract) || '').trim();
    if (spec.template === 'download_image') {
      if (!raw) return { error: 'empty image URL', retryable: false };
      const imageUrl = raw.startsWith('http') ? raw : new URL(raw, page.url()).toString();
      log.info('generate complete', { imageUrl });
      return { imageUrl };
    }
    const text = raw;
    if (!text) return { error: 'empty response', retryable: false };
    log.info('generate complete', { textChars: text.length });
    return { text };
  } catch (err) {
    log.error('generate failed', { error: err.message || String(err) });
    return normalizeError(err, 'generate');
  }
}

export const manifest = {
  id: spec.id,
  displayName: ${jsString(spec.displayName)},
  description: ${jsString(spec.description)},
  models: spec.models,
  navigationHandlers: []
};

const noopLogger = {
  child() { return this; },
  debug() {},
  info() {},
  warn() {},
  error() {}
};
`;
}

export function buildAdapterSource(plan, options = {}) {
  const kind = targetKind({ targetKind: options.targetKind });
  if (kind === 'web2web-sidecar') return buildWeb2WebSidecarSource(plan, options);
  return buildWebAI2APISource(plan, options);
}

export function buildWorkerConfigSnippet(adapterId, options = {}) {
  const workerName = sanitizeIdentifier(options.workerName || adapterId, adapterId);
  if (targetKind({ targetKind: options.targetKind }) === 'web2web-sidecar') {
    return `{
  "backend": {
    "pool": {
      "instances": [{
        "name": "browser_default",
        "workers": [{
          "name": "${workerName}",
          "type": "${adapterId}"
        }]
      }]
    }
  }
}`;
  }
  return `backend:
  pool:
    instances:
      - name: "browser_default"
        workers:
          - name: "${workerName}"
            type: ${adapterId}
`;
}

export async function loadInterfacePlan(captureDir) {
  const interfacePath = path.join(captureDir, 'interface.json');
  try {
    return JSON.parse(await fs.readFile(interfacePath, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const bundle = await loadCaptureBundle(captureDir);
    return buildInterfacePlan(bundle);
  }
}

async function readJsonIfExists(filePath) {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

function validateScoreThreshold(value) {
  const score = Number(value ?? DEFAULT_LOCATOR_SCORE);
  if (!Number.isFinite(score) || score < 0 || score > 100) {
    throw new Error('--min-locator-score must be between 0 and 100');
  }
  return score;
}

function normalizeLocatorValidation(validation, minLocatorScore) {
  if (validation?.schemaVersion !== 'web-adapter-tools.locator-validation.v1') {
    throw new Error('locator-validation.json schemaVersion 不正确');
  }
  if (!Array.isArray(validation.results)) {
    throw new Error('locator-validation.json 缺少 results');
  }
  const results = validation.results;
  const scores = results.map(result => Number(result.stableScore || 0));
  const minScore = scores.length ? Math.min(...scores) : 0;
  const averageScore = scores.length
    ? Math.round(scores.reduce((sum, score) => sum + score, 0) / scores.length)
    : 0;
  const unstable = results.filter(result => Number(result.stableScore || 0) < minLocatorScore);
  return {
    ...validation,
    threshold: minLocatorScore,
    locatorCount: results.length,
    minScore,
    averageScore,
    ok: unstable.length === 0,
    unstableCount: unstable.length
  };
}

function locatorFailureDetails(validation) {
  return (validation.results || [])
    .filter(result => Number(result.stableScore || 0) < validation.threshold)
    .slice(0, 8)
    .map(result => `  - ${result.path}: ${result.stableScore}/100 ${result.expression || ''}`.trimEnd())
    .join('\n');
}

export async function ensureLocatorValidationGate(captureDir, options = {}) {
  const minLocatorScore = validateScoreThreshold(options.minLocatorScore);
  if (options.force) {
    return {
      skipped: true,
      minLocatorScore
    };
  }

  const root = path.resolve(captureDir);
  const validationPath = path.join(root, 'locator-validation.json');
  let validation = await readJsonIfExists(validationPath);
  let generated = false;
  let artifacts = null;
  let plan = null;
  let interfacePath = options.interfacePath ? path.resolve(options.interfacePath) : path.join(root, 'interface.json');

  if (validation) {
    validation = normalizeLocatorValidation(validation, minLocatorScore);
  } else {
    const inputs = await loadLocatorValidationInputs(root, {
      interfacePath: options.interfacePath
    });
    plan = inputs.plan;
    interfacePath = inputs.interfacePath;
    validation = validateInterfaceLocators(plan, inputs.snapshots, { minScore: minLocatorScore });
    artifacts = await writeLocatorValidationArtifacts(validation, root);
    generated = true;
  }

  let wroteInterface = false;
  if (options.writeValidation) {
    if (!plan) {
      const inputs = await loadLocatorValidationInputs(root, {
        interfacePath: options.interfacePath
      });
      plan = inputs.plan;
      interfacePath = inputs.interfacePath;
    }
    const annotated = applyLocatorValidation(plan, validation);
    await fs.writeFile(interfacePath, JSON.stringify(annotated, null, 2), 'utf8');
    wroteInterface = true;
  }

  if (!validation.ok) {
    const details = locatorFailureDetails(validation);
    const hint = `Run pnpm validate-interface ${captureDir} --min-score ${minLocatorScore} --write, fix weak locators, or pass --force to skip this gate.`;
    throw Object.assign(
      new Error(`Locator validation failed: ${validation.unstableCount} locator(s) below ${minLocatorScore}/100.\n${details}\n${hint}`),
      { validation }
    );
  }

  return {
    artifacts,
    generated,
    minLocatorScore,
    validation,
    validationPath: artifacts?.jsonPath || validationPath,
    markdownPath: artifacts?.mdPath || path.join(root, 'locator-validation.md'),
    wroteInterface
  };
}

export async function writeAdapterFromCapture(captureDir, options = {}) {
  const plan = await loadInterfacePlan(captureDir);
  const source = buildAdapterSource(plan, options);
  const adapterId = sanitizeIdentifier(options.id || `${plan.operation?.name || 'generated'}_text`);
  const kind = targetKind({ targetKind: options.targetKind });
  const targetRoot = path.resolve(options.target || (kind === 'web2web-sidecar' ? '../server' : '../WebAI2API'));
  const adapterDir = kind === 'web2web-sidecar'
    ? path.join(targetRoot, 'sidecar', 'src', 'adapters')
    : path.join(targetRoot, 'src', 'backend', 'adapter');
  const adapterPath = path.join(adapterDir, `${adapterId}.js`);

  await fs.mkdir(adapterDir, { recursive: true });
  await fs.writeFile(adapterPath, source, 'utf8');

  return {
    adapterId,
    adapterPath,
    source,
    configSnippet: buildWorkerConfigSnippet(adapterId, { ...options, targetKind: kind }),
    modelId: compact(options.model || DEFAULT_MODEL_ID, 80),
    targetKind: kind,
    targetRoot
  };
}
