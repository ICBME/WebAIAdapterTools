import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { collectLocatorRefs } from './locatorValidator.js';

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

function compact(value, max = 240) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function safeLocatorExpression(expression, label = 'locator') {
  const value = String(expression || '').trim();
  if (!value) throw new Error(`${label} is empty`);
  if (!LOCATOR_PREFIXES.some(prefix => value.startsWith(prefix))) {
    throw new Error(`${label} is not an allowed Playwright locator expression: ${value}`);
  }
  if (/[\n\r;`]|\b(?:eval|Function|import|require|process|globalThis|window|document)\b/.test(value)) {
    throw new Error(`${label} contains disallowed code: ${value}`);
  }
  return value;
}

export function compileLocatorExpression(expression, label = 'locator') {
  const safe = safeLocatorExpression(expression, label);
  return page => {
    // The expression is constrained to whitelisted page locator APIs above.
    // eslint-disable-next-line no-new-func
    return Function('page', `"use strict"; return (${safe});`)(page);
  };
}

function inferFromUrlObject(value) {
  if (!value) return '';
  if (typeof value === 'string') return value;
  if (value.display) return value.display;
  if (value.origin) return `${value.origin}${value.path || '/'}`;
  return '';
}

export function inferDynamicTargetUrl(plan, profile = {}, options = {}) {
  if (options.targetUrl) return options.targetUrl;
  if (options.fixture) {
    if (/^https?:\/\//i.test(options.fixture) || options.fixture.startsWith('file://')) return options.fixture;
    return pathToFileURL(path.resolve(options.fixture)).href;
  }
  const gotoStep = (plan.operation?.steps || []).find(step => step.type === 'goto' && step.url);
  return inferFromUrlObject(gotoStep?.url) ||
    inferFromUrlObject(plan.source?.initialUrl) ||
    inferFromUrlObject(plan.source?.finalUrl) ||
    profile.capture?.finalUrl ||
    profile.capture?.initialUrl ||
    '';
}

async function optionalBool(fn, fallback = false) {
  try {
    return await fn();
  } catch {
    return fallback;
  }
}

function dynamicStatus(score) {
  return score >= 80 ? 'stable' : score >= 50 ? 'warning' : 'unstable';
}

export function scoreDynamicChecks(kind, checks, options = {}) {
  if (checks.error) return 0;
  if (!checks.count) {
    if ((kind === 'output' || kind === 'waitSignal') && options.allowMissingOutputBefore !== false) return 70;
    return 0;
  }
  let score = checks.count === 1 ? 45 : 30;
  if (checks.visible) score += 20;
  if (kind === 'input' || kind === 'textInput') {
    if (checks.editable) score += 25;
    else if (checks.enabled) score += 10;
  } else if (kind === 'submit' || kind === 'upload' || kind === 'select' || kind === 'toggle') {
    if (checks.enabled) score += 25;
  } else if (kind === 'hover' || kind === 'scroll' || kind === 'waitSignal') {
    if (checks.attached) score += 10;
    if (checks.enabled && kind === 'hover') score += 10;
  } else if (checks.count === 1) {
    score += 10;
  }
  return Math.max(0, Math.min(100, Math.round(score)));
}

export async function evaluateLocatorDynamically(page, ref, options = {}) {
  const expression = ref.locator?.value || ref.expression || '';
  const timeout = Number(options.timeout || 30000);
  const checks = {
    count: 0,
    visible: false,
    editable: false,
    enabled: false,
    attached: false,
    beforeMissingAllowed: false
  };

  try {
    const locator = compileLocatorExpression(expression, ref.path)(page);
    checks.count = typeof locator.count === 'function' ? await locator.count() : 1;
    if (!checks.count) {
      checks.beforeMissingAllowed = (ref.kind === 'output' || ref.kind === 'waitSignal') && options.allowMissingOutputBefore !== false;
      const score = scoreDynamicChecks(ref.kind, checks, options);
      return {
        path: ref.path,
        kind: ref.kind,
        expression,
        score,
        status: dynamicStatus(score),
        checks,
        error: null
      };
    }

    const target = typeof locator.first === 'function' ? locator.first() : locator;
    await target.waitFor?.({ state: ref.kind === 'output' ? 'attached' : 'visible', timeout }).catch(() => {});
    checks.attached = true;
    checks.visible = await optionalBool(() => target.isVisible({ timeout }), false);
    checks.enabled = await optionalBool(() => target.isEnabled({ timeout }), false);
    checks.editable = await optionalBool(() => target.isEditable({ timeout }), false);
    const score = scoreDynamicChecks(ref.kind, checks, options);
    return {
      path: ref.path,
      kind: ref.kind,
      expression,
      score,
      status: dynamicStatus(score),
      checks,
      error: null
    };
  } catch (error) {
    return {
      path: ref.path,
      kind: ref.kind,
      expression,
      score: 0,
      status: 'unstable',
      checks: { ...checks, error: true },
      error: compact(error.message || String(error))
    };
  }
}

export async function validateInterfaceLocatorsDynamic(plan, page, options = {}) {
  const refs = collectLocatorRefs(plan);
  const results = [];
  for (const ref of refs) {
    results.push(await evaluateLocatorDynamically(page, ref, options));
  }
  const scores = results.map(result => result.score);
  const threshold = Number(options.minScore || 70);
  const minScore = scores.length ? Math.min(...scores) : 0;
  const averageScore = scores.length ? Math.round(scores.reduce((sum, score) => sum + score, 0) / scores.length) : 0;
  const unstable = results.filter(result => result.score < threshold);
  return {
    enabled: true,
    url: options.url || '',
    headless: Boolean(options.headless),
    timeoutMs: Number(options.timeout || 30000),
    threshold,
    ok: unstable.length === 0,
    minScore,
    averageScore,
    unstableCount: unstable.length,
    results
  };
}

export function mergeDynamicLocatorValidation(staticValidation, dynamicValidation) {
  const dynamicByPath = new Map((dynamicValidation.results || []).map(result => [result.path, result]));
  const results = (staticValidation.results || []).map(result => {
    const dynamic = dynamicByPath.get(result.path);
    if (!dynamic) return result;
    return {
      ...result,
      dynamicScore: dynamic.score,
      dynamicStatus: dynamic.status,
      dynamicChecks: dynamic.checks,
      dynamicError: dynamic.error,
      dynamic: {
        score: dynamic.score,
        status: dynamic.status,
        checks: dynamic.checks,
        error: dynamic.error
      }
    };
  });
  const ok = Boolean(staticValidation.ok && dynamicValidation.ok);
  return {
    ...staticValidation,
    mode: 'static+dynamic',
    ok,
    dynamic: {
      enabled: true,
      url: dynamicValidation.url,
      headless: dynamicValidation.headless,
      timeoutMs: dynamicValidation.timeoutMs,
      threshold: dynamicValidation.threshold,
      ok: dynamicValidation.ok,
      minScore: dynamicValidation.minScore,
      averageScore: dynamicValidation.averageScore,
      unstableCount: dynamicValidation.unstableCount
    },
    results
  };
}

async function loadCamoufox() {
  try {
    return await import('camoufox-js');
  } catch (error) {
    throw new Error(`camoufox-js is not installed. Run "pnpm install" in WebAdapterTools. Original error: ${error.message}`);
  }
}

export async function runDynamicLocatorValidation(plan, profile, options = {}) {
  const url = inferDynamicTargetUrl(plan, profile, options);
  if (!url) throw new Error('Cannot infer dynamic validation URL');
  const { Camoufox } = await loadCamoufox();
  const browser = await Camoufox({
    headless: Boolean(options.headless),
    user_data_dir: options.userDataDir ? path.resolve(options.userDataDir) : undefined,
    executable_path: options.browserPath ? path.resolve(options.browserPath) : undefined,
    i_know_what_im_doing: true
  });
  try {
    const page = await browser.newPage();
    await page.goto(url, { waitUntil: options.waitUntil || 'load', timeout: Number(options.timeout || 30000) });
    return await validateInterfaceLocatorsDynamic(plan, page, {
      ...options,
      url
    });
  } finally {
    await browser.close().catch(() => {});
  }
}
