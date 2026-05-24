import fs from 'node:fs/promises';
import path from 'node:path';

const JSON_SPACE = 2;
const DIAGNOSIS_TYPES = new Set([
  'input_locator_timeout',
  'submit_locator_timeout',
  'output_locator_timeout',
  'network_signal_timeout',
  'empty_output',
  'auth_required',
  'captcha_or_verification',
  'download_failed',
  'page_navigation_failed'
]);

function compact(value, max = 240) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function includesAny(text, patterns) {
  return patterns.some(pattern => pattern.test(text));
}

function lastStep(steps = []) {
  return steps.length ? steps[steps.length - 1] : null;
}

function hasStep(steps = [], name) {
  return steps.some(step => step.name === name);
}

function joinedFailureText(summary = {}) {
  const stepText = (summary.steps || [])
    .map(step => `${step.name || ''} ${step.label || ''} ${step.url || ''} ${step.title || ''} ${step.error || ''}`)
    .join(' ');
  return compact(`${summary.result?.error || ''} ${summary.error || ''} ${stepText}`, 2000).toLowerCase();
}

function primaryType(summary = {}) {
  const text = joinedFailureText(summary);
  const steps = summary.steps || [];
  const error = String(summary.result?.error || summary.error || '').toLowerCase();

  if (includesAny(text, [/\bcaptcha\b/, /human verification/, /verification required/, /verify you are human/, /验证码/, /人机验证/])) {
    return 'captcha_or_verification';
  }
  if (includesAny(text, [/\blog\s*in\b/, /\bsign\s*in\b/, /\bauth\b/, /unauthorized/, /forbidden/, /登录/, /登陆/, /授权/])) {
    return 'auth_required';
  }
  if (includesAny(error, [/net::err/, /navigation/, /goto/, /target url/, /page.goto/, /打开目标站点/])) {
    return 'page_navigation_failed';
  }
  if (includesAny(error, [/download/, /图片/, /image url/, /empty image/, /图片地址为空/])) {
    return 'download_failed';
  }
  if (includesAny(error, [/waitforresponse/, /network signal/, /network.*timeout/, /sse/, /stream/])) {
    return 'network_signal_timeout';
  }
  if (includesAny(error, [/输出内容为空/, /empty response/, /empty output/, /no output/, /text length.*0/])) {
    return 'empty_output';
  }
  if (includesAny(error, [/timeout/, /waiting/, /locator/])) {
    if (hasStep(steps, 'before-input-ready') && !hasStep(steps, 'after-input-ready')) return 'input_locator_timeout';
    if (hasStep(steps, 'before-submit') && !hasStep(steps, 'after-submit')) return 'submit_locator_timeout';
    if (hasStep(steps, 'before-output-wait') && !hasStep(steps, 'after-output-visible')) return 'output_locator_timeout';
  }
  if (hasStep(steps, 'before-output-wait') && !hasStep(steps, 'after-output-visible')) return 'output_locator_timeout';
  if (hasStep(steps, 'before-submit') && !hasStep(steps, 'after-submit')) return 'submit_locator_timeout';
  if (hasStep(steps, 'before-input-ready') && !hasStep(steps, 'after-input-ready')) return 'input_locator_timeout';
  if (!summary.textLength && !summary.imageLength) return 'empty_output';
  return 'empty_output';
}

function confidenceFor(type, summary = {}) {
  const steps = summary.steps || [];
  if (['auth_required', 'captcha_or_verification', 'page_navigation_failed'].includes(type)) return 0.85;
  if (type === 'empty_output') return 0.7;
  if (type.endsWith('_locator_timeout') && steps.length) return 0.78;
  return 0.65;
}

function loadPlanLocatorPath(plan, type) {
  if (!plan?.operation) return null;
  if (type === 'input_locator_timeout') return 'operation.inputs[0].locator';
  if (type === 'submit_locator_timeout') return 'operation.submit.locator';
  if (type === 'output_locator_timeout' || type === 'empty_output') {
    if (plan.operation.outputs?.[0]?.locator) return 'operation.outputs[0].locator';
    if (plan.operation.extractors?.[0]?.locator) return 'operation.extractors[0].locator';
  }
  if (type === 'download_failed') {
    if (plan.operation.extractors?.[0]) return 'operation.extractors[0]';
    if (plan.operation.outputs?.[0]) return 'operation.outputs[0]';
  }
  return null;
}

function waitSignalPatchOperations(plan, type) {
  const operations = [];
  const signals = plan?.operation?.waitSignals || [];
  if (type === 'network_signal_timeout') {
    signals.forEach((signal, index) => {
      if (['network-response', 'network-stream'].includes(signal.type)) {
        operations.push({
          op: 'add',
          path: `/operation/waitSignals/${index}/disabled`,
          value: true,
          reason: 'Network wait signal did not complete during verification.'
        });
      }
    });
  }
  if (type === 'output_locator_timeout' || type === 'empty_output') {
    signals.forEach((signal, index) => {
      if (signal.type === 'dom-visible') {
        operations.push({
          op: 'add',
          path: `/operation/waitSignals/${index}/stability`,
          value: {
            status: 'warning',
            source: 'verify-diagnosis',
            diagnosisType: type
          },
          reason: 'DOM output wait did not produce a usable visible result during verification.'
        });
      }
    });
  }
  return operations;
}

function patchPathFromPlanPath(planPath) {
  if (!planPath) return '';
  return `/${planPath.replace(/\[(\d+)\]/g, '.$1').split('.').join('/')}`;
}

function buildPatch(summary, diagnosis, plan = null) {
  const type = diagnosis.type;
  const operations = [];
  const locatorPath = loadPlanLocatorPath(plan, type);
  if (locatorPath) {
    operations.push({
      op: 'add',
      path: `${patchPathFromPlanPath(locatorPath)}/stability`,
      value: {
        status: 'warning',
        source: 'verify-diagnosis',
        diagnosisType: type
      },
      reason: `Verification diagnosed ${type}. Revalidate this locator dynamically or replace it with a stronger alternate.`
    });
  }

  operations.push(...waitSignalPatchOperations(plan, type));

  if (type === 'network_signal_timeout' && plan?.operation?.template === 'sse_text') {
    operations.push({
      op: 'replace',
      path: '/operation/template',
      value: 'dom_text',
      reason: 'SSE/network signal timed out; DOM extraction may be safer until a schema-backed extractor is available.'
    });
  }

  if (type === 'auth_required' || type === 'captcha_or_verification') {
    operations.push({
      op: 'add',
      path: '/operation/requirements',
      value: {
        manualProfile: true
      },
      reason: 'Verification appears blocked by login, authorization, captcha, or human verification.'
    });
  }

  if (type === 'download_failed') {
    operations.push({
      op: 'add',
      path: '/operation/extractors/0/stability',
      value: {
        status: 'warning',
        source: 'verify-diagnosis',
        diagnosisType: type
      },
      reason: 'Download/image extraction failed; inspect DOM image extractor or infer image URL from network schema.'
    });
  }

  return {
    schemaVersion: 'web-adapter-tools.interface-patch.v1',
    generatedAt: new Date().toISOString(),
    source: {
      adapterId: summary.adapterId || '',
      verifyOk: Boolean(summary.ok),
      diagnosisType: type
    },
    operations,
    notes: diagnosis.recommendations
  };
}

function recommendationsFor(type) {
  const map = {
    input_locator_timeout: [
      'Run dynamic locator validation for the input locator.',
      'Prefer role/name, label, placeholder, or test-id locators over structural CSS.'
    ],
    submit_locator_timeout: [
      'Revalidate the submit locator and check whether Enter on the input is more stable.',
      'Check disabled/enabled state after filling the prompt.'
    ],
    output_locator_timeout: [
      'Revalidate the output locator after submit; output may not exist before generation.',
      'Consider a broader output container or a network-backed completion signal.'
    ],
    network_signal_timeout: [
      'Mark the stale network waitSignal invalid or lower its confidence.',
      'If the template is sse_text, fall back to dom_text until network schema extractors are inferred.'
    ],
    empty_output: [
      'Keep the output locator but lower its stability until extraction is proven.',
      'Try textContent instead of innerText, or select the newest assistant/result node.'
    ],
    auth_required: [
      'Verify with a prepared user profile that is already logged in.',
      'Record auth state as a manual requirement instead of automating login.'
    ],
    captcha_or_verification: [
      'Mark the adapter as requiring manual verification/profile preparation.',
      'Do not automate captcha or human-verification controls.'
    ],
    download_failed: [
      'Inspect the image extractor and download URL source.',
      'Prefer a network-schema-inferred image URL field when available.'
    ],
    page_navigation_failed: [
      'Check targetUrl and whether the page blocks automated or headless navigation.',
      'Retry with a prepared headed profile before changing locators.'
    ]
  };
  return map[type] || [];
}

export function diagnoseVerifyFailure(summary = {}, options = {}) {
  if (summary.ok) {
    return {
      schemaVersion: 'web-adapter-tools.verify-diagnosis.v1',
      generatedAt: new Date().toISOString(),
      ok: true,
      adapterId: summary.adapterId || '',
      diagnoses: []
    };
  }
  const type = primaryType(summary);
  const step = lastStep(summary.steps || []);
  const diagnosis = {
    type: DIAGNOSIS_TYPES.has(type) ? type : 'empty_output',
    confidence: confidenceFor(type, summary),
    message: compact(summary.result?.error || summary.error || `Verification failed near ${step?.name || 'unknown step'}`),
    evidence: {
      lastStep: step ? {
        name: step.name || '',
        label: step.label || '',
        url: step.url || '',
        title: step.title || '',
        error: step.error || null
      } : null,
      textLength: summary.textLength || 0,
      imageLength: summary.imageLength || 0
    },
    recommendations: recommendationsFor(type)
  };

  return {
    schemaVersion: 'web-adapter-tools.verify-diagnosis.v1',
    generatedAt: new Date().toISOString(),
    ok: false,
    adapterId: summary.adapterId || '',
    modelId: summary.modelId || '',
    sourceVerify: options.verifyPath || summary.artifacts?.verifyPath || '',
    diagnoses: [diagnosis],
    primary: diagnosis
  };
}

async function readJson(filePath, fallback = null) {
  if (!filePath) return fallback;
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw error;
  }
}

export async function writeFailureDiagnosisArtifacts(summary = {}, options = {}) {
  const outDir = options.outDir ? path.resolve(options.outDir) : summary.artifacts?.outDir;
  if (!outDir || summary.ok) return {};
  await fs.mkdir(outDir, { recursive: true });

  const interfacePath = options.interfacePath ||
    (options.captureDir ? path.join(path.resolve(options.captureDir), 'interface.json') : null);
  const plan = await readJson(interfacePath, null);
  const diagnosis = diagnoseVerifyFailure(summary, {
    verifyPath: summary.artifacts?.verifyPath
  });
  const patch = buildPatch(summary, diagnosis.primary, plan);

  const diagnosePath = path.join(outDir, 'diagnose.json');
  const patchPath = path.join(outDir, 'interface.patch.json');
  await fs.writeFile(diagnosePath, JSON.stringify(diagnosis, null, JSON_SPACE), 'utf8');
  await fs.writeFile(patchPath, JSON.stringify(patch, null, JSON_SPACE), 'utf8');

  if (options.writeBack && interfacePath && plan) {
    const annotated = {
      ...plan,
      verificationDiagnosis: {
        schemaVersion: diagnosis.schemaVersion,
        generatedAt: diagnosis.generatedAt,
        adapterId: diagnosis.adapterId,
        type: diagnosis.primary.type,
        confidence: diagnosis.primary.confidence,
        message: diagnosis.primary.message,
        patchFile: path.relative(path.dirname(interfacePath), patchPath).replaceAll(path.sep, '/')
      }
    };
    await fs.writeFile(interfacePath, JSON.stringify(annotated, null, JSON_SPACE), 'utf8');
  }

  return {
    diagnosePath,
    patchPath,
    interfacePath: plan ? interfacePath : null,
    wroteBack: Boolean(options.writeBack && interfacePath && plan),
    diagnosis,
    patch
  };
}
