import fs from 'node:fs/promises';
import path from 'node:path';
import { collectPageProfile, defaultUserDataDir } from './collector.js';
import { writeCaptureArtifacts } from './artifacts.js';
import { buildInterfacePlan, loadCaptureBundle, writeInterfaceArtifacts } from './interfaceAnalyzer.js';
import { ensureLocatorValidationGate, writeAdapterFromCapture } from './adapterGenerator.js';
import { verifyAdapter } from './adapterVerifier.js';
import { DEFAULT_WINDOW_SIZE } from './size.js';
import {
  buildAiGoalFromAdapterPlan,
  compactAdapterPlanForAi,
  defaultMaxStepsForAdapterPlan,
  getBuiltInAdapterPlan,
  renderAdapterPlanMarkdown,
  stringifyAdapterPlan,
  WEBAI2API_CHATGPT_REFERENCE_PLAN
} from './adapterPlan.js';

const JSON_SPACE = 2;

export const WEBAI2API_ADAPTER_WORKFLOW = [
  {
    id: 'open-target',
    title: 'Open target page',
    detail: 'Navigate to getTargetUrl/TARGET_URL and normalize page errors with gotoWithCheck.'
  },
  {
    id: 'wait-ready',
    title: 'Wait for usable input',
    detail: 'Locate the main prompt/input surface and wait until it is visible and editable.'
  },
  {
    id: 'optional-setup',
    title: 'Apply optional setup',
    detail: 'Handle model selection, temporary chat flags, login-prepared profiles, uploads, or feature-specific setup.'
  },
  {
    id: 'submit-request',
    title: 'Submit prompt',
    detail: 'Fill/type prompt, submit with Enter or a stable send button, and avoid racing by starting output waits before submit when possible.'
  },
  {
    id: 'wait-output',
    title: 'Wait for result signal',
    detail: 'Use DOM output, network response, SSE completion, file/download status, or page state changes as completion evidence.'
  },
  {
    id: 'extract-result',
    title: 'Extract result',
    detail: 'Return { text }, { image }, or { error } with retryable=false for known terminal errors.'
  },
  {
    id: 'manifest',
    title: 'Expose manifest',
    detail: 'Export manifest with id, displayName, models, getTargetUrl, navigationHandlers, and generate.'
  }
];

function resolveAdapterPlan(options = {}) {
  if (options.adapterPlan === false || options.plan === false || options.plan === 'none') return null;
  if (options.adapterPlan && typeof options.adapterPlan === 'object') return options.adapterPlan;
  const planId = options.plan || options.adapterPlanId || WEBAI2API_CHATGPT_REFERENCE_PLAN.id;
  return getBuiltInAdapterPlan(planId);
}

function compact(value, max = 200) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function safeId(value, fallback = 'generated_ai_adapter_text') {
  const cleaned = String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return /^[a-z][a-z0-9_]*$/.test(cleaned) ? cleaned : fallback;
}

export function buildAdapterWorkflowPlan(options = {}) {
  const adapterId = safeId(options.id || options.adapterId);
  const adapterPlan = resolveAdapterPlan(options);
  const aiMaxSteps = Number(options.aiMaxSteps || defaultMaxStepsForAdapterPlan(adapterPlan));
  return {
    schemaVersion: 'web-adapter-tools.adapter-workflow.v1',
    generatedAt: new Date().toISOString(),
    targetUrl: options.url || '',
    captureDir: options.out || options.captureDir || '',
    webai2apiTarget: options.target || '',
    targetKind: options.targetKind || 'webai2api',
    adapter: {
      id: adapterId,
      model: options.model || 'generated-browser-text',
      displayName: options.displayName || adapterId.replace(/_/g, ' ')
    },
    ai: {
      goal: options.aiGoal || (adapterPlan ? buildAiGoalFromAdapterPlan(adapterPlan, options) : ''),
      inputPreview: compact(options.aiInput, 160),
      mode: options.aiMode || 'hybrid',
      provider: options.aiProvider || 'raw',
      maxSteps: aiMaxSteps,
      timeoutMs: Number(options.aiTimeout || 180000),
      minConfidence: Number(options.aiMinConfidence ?? 0.7)
    },
    adapterPlan: adapterPlan ? compactAdapterPlanForAi(adapterPlan) : null,
    workflow: WEBAI2API_ADAPTER_WORKFLOW
  };
}

export function renderAdapterWorkflowMarkdown(workflow, result = {}) {
  const lines = [];
  lines.push(`# WebAI2API Adapter AI Workflow`);
  lines.push('');
  lines.push(`Target: ${workflow.targetUrl || '(unknown)'}`);
  lines.push(`Adapter: \`${workflow.adapter.id}\``);
  lines.push(`AI mode: ${workflow.ai.mode}`);
  lines.push(`AI provider: ${workflow.ai.provider}`);
  if (workflow.adapterPlan) lines.push(`Adapter plan: \`${workflow.adapterPlan.id}\``);
  lines.push('');
  if (workflow.adapterPlan) {
    lines.push('## Adapter Generation Plan');
    lines.push('');
    lines.push(`Plan: ${workflow.adapterPlan.title}`);
    lines.push('');
    lines.push('Required interfaces:');
    lines.push(`- Generate: \`${workflow.adapterPlan.requiredInterfaces.generateSignature}\``);
    lines.push(`- Manifest fields: ${workflow.adapterPlan.requiredInterfaces.manifestFields.map(item => `\`${item}\``).join(', ')}`);
    lines.push(`- Return shape: ${workflow.adapterPlan.requiredInterfaces.returnShape.map(item => `\`${item}\``).join(', ')}`);
    lines.push('');
    lines.push('Operation capture requirements:');
    for (const operation of workflow.adapterPlan.operations || []) {
      lines.push(`- ${operation.required ? 'Required' : 'Optional'} \`${operation.id}\`: ${operation.title}`);
    }
    lines.push('');
  }
  lines.push('## Common WebAI2API Adapter Flow');
  for (const step of workflow.workflow) {
    lines.push(`- **${step.title}**: ${step.detail}`);
  }
  lines.push('');
  lines.push('## Generated Artifacts');
  if (result.captureIndexPath) lines.push(`- Capture index: \`${result.captureIndexPath}\``);
  if (result.interfacePath) lines.push(`- Interface plan: \`${result.interfacePath}\``);
  if (result.locatorValidation?.path) lines.push(`- Locator validation: \`${result.locatorValidation.path}\``);
  if (result.adapterPath) lines.push(`- Adapter: \`${result.adapterPath}\``);
  if (result.verify?.artifacts?.outDir) lines.push(`- Verify artifacts: \`${result.verify.artifacts.outDir}\``);
  if (result.error) lines.push(`- Error: ${result.error}`);
  lines.push('');
  lines.push('## Workflow Status');
  for (const step of result.steps || []) {
    const detail = step.error ? ` - ${step.error}` : '';
    lines.push(`- ${step.status || 'unknown'}: ${step.id}${detail}`);
  }
  if (result.ok !== undefined) lines.push(`- Final verdict: ${result.ok ? 'passed' : 'failed'}`);
  lines.push('');
  return lines.join('\n');
}

async function writeWorkflowArtifacts(captureDir, workflow, result = {}) {
  await fs.mkdir(captureDir, { recursive: true });
  const jsonPath = path.join(captureDir, 'adapter-workflow.json');
  const mdPath = path.join(captureDir, 'adapter-workflow.md');
  const captureJsonPath = path.join(captureDir, 'capture-workflow.json');
  const captureMdPath = path.join(captureDir, 'capture-workflow.md');
  const payload = {
    schemaVersion: 'web-adapter-tools.capture-workflow.v1',
    workflow,
    result
  };
  await fs.writeFile(jsonPath, JSON.stringify({ workflow, result }, null, JSON_SPACE), 'utf8');
  await fs.writeFile(mdPath, renderAdapterWorkflowMarkdown(workflow, result), 'utf8');
  await fs.writeFile(captureJsonPath, JSON.stringify(payload, null, JSON_SPACE), 'utf8');
  await fs.writeFile(captureMdPath, renderAdapterWorkflowMarkdown(workflow, result), 'utf8');
  const artifacts = { jsonPath, mdPath, captureJsonPath, captureMdPath };
  if (result.fullAdapterPlan) {
    const planJsonPath = path.join(captureDir, 'adapter-plan.json');
    const planMdPath = path.join(captureDir, 'adapter-plan.md');
    await fs.writeFile(planJsonPath, stringifyAdapterPlan(result.fullAdapterPlan), 'utf8');
    await fs.writeFile(planMdPath, renderAdapterPlanMarkdown(result.fullAdapterPlan), 'utf8');
    artifacts.planJsonPath = planJsonPath;
    artifacts.planMdPath = planMdPath;
  }
  return artifacts;
}

export async function runAiAdapterWorkflow(options = {}) {
  if (!options.url) throw new Error('url is required');
  if (!options.out) throw new Error('out is required');
  if (!options.target) throw new Error('target is required');
  if (!options.id && !options.adapterId) throw new Error('adapter id is required');
  const adapterPlan = resolveAdapterPlan(options);
  const aiGoal = options.aiGoal || (adapterPlan ? buildAiGoalFromAdapterPlan(adapterPlan, options) : '');
  const aiMaxSteps = Number(options.aiMaxSteps || defaultMaxStepsForAdapterPlan(adapterPlan));
  if (!aiGoal) throw new Error('aiGoal is required when no adapter plan is used');

  const captureDir = path.resolve(options.out);
  const targetRoot = path.resolve(options.target);
  const workflow = buildAdapterWorkflowPlan({
    ...options,
    out: captureDir,
    target: targetRoot
  });
  const result = {
    startedAt: new Date().toISOString(),
    steps: []
  };
  if (adapterPlan) result.fullAdapterPlan = adapterPlan;

  try {
    result.steps.push({ id: 'collect', status: 'started', at: new Date().toISOString() });
    const profile = await collectPageProfile({
      url: options.url,
      userDataDir: path.resolve(options.userDataDir || defaultUserDataDir()),
      headless: Boolean(options.headless),
      timeout: Number(options.timeout || 60000),
      browserPath: options.browserPath ? path.resolve(options.browserPath) : null,
      windowSize: options.windowSize || DEFAULT_WINDOW_SIZE,
      browserControls: Boolean(options.browserControls),
      recordAction: true,
      aiRecordAction: true,
      aiGoal,
      aiInput: options.aiInput || '',
      aiPlan: adapterPlan ? compactAdapterPlanForAi(adapterPlan) : null,
      aiMode: options.aiMode || 'hybrid',
      aiProvider: options.aiProvider || 'raw',
      aiTimeout: Number(options.aiTimeout || 180000),
      aiMaxSteps,
      aiModel: options.aiModel || null,
      aiMinConfidence: Number(options.aiMinConfidence ?? 0.7),
      waitForUser: options.waitForUser || null
    });
    await fs.mkdir(captureDir, { recursive: true });
    const index = await writeCaptureArtifacts(profile, captureDir);
    result.captureIndexPath = path.join(captureDir, 'profile.json');
    result.capture = {
      actionMode: index.action?.mode || null,
      eventCount: index.action?.eventCount || 0,
      fallbackCount: index.action?.fallbackCount || 0
    };
    result.steps[result.steps.length - 1].status = 'completed';

    result.steps.push({ id: 'analyze', status: 'started', at: new Date().toISOString() });
    const bundle = await loadCaptureBundle(captureDir);
    const plan = buildInterfacePlan(bundle);
    await writeInterfaceArtifacts(plan, captureDir);
    result.interfacePath = path.join(captureDir, 'interface.json');
    result.interface = {
      operation: plan.operation?.name || '',
      confidence: plan.operation?.confidence || 0,
      warnings: plan.warnings || []
    };
    result.steps[result.steps.length - 1].status = 'completed';

    result.steps.push({ id: 'locator-validation', status: 'started', at: new Date().toISOString() });
    const locatorGate = await ensureLocatorValidationGate(captureDir, {
      minLocatorScore: options.minLocatorScore ?? 70,
      writeValidation: options.writeValidation ?? true,
      force: Boolean(options.forceLocatorValidation || options.force),
      dynamicValidation: Boolean(options.dynamicValidation),
      dynamicTimeout: options.dynamicValidationTimeout || options.timeout,
      dynamicTargetUrl: options.dynamicValidationTargetUrl || options.targetUrl,
      dynamicFixture: options.dynamicValidationFixture,
      dynamicUserDataDir: options.dynamicValidationUserDataDir || options.userDataDir,
      dynamicBrowserPath: options.dynamicValidationBrowserPath || options.browserPath,
      dynamicHeadless: options.dynamicValidationHeadless ?? options.headless ?? true
    });
    result.locatorValidation = {
      skipped: Boolean(locatorGate.skipped),
      generated: Boolean(locatorGate.generated),
      minLocatorScore: locatorGate.minLocatorScore,
      path: locatorGate.validationPath || null,
      markdownPath: locatorGate.markdownPath || null,
      wroteInterface: Boolean(locatorGate.wroteInterface),
      ok: locatorGate.skipped ? null : Boolean(locatorGate.validation?.ok),
      locatorCount: locatorGate.validation?.locatorCount || 0,
      minScore: locatorGate.validation?.minScore || 0,
      averageScore: locatorGate.validation?.averageScore || 0,
      unstableCount: locatorGate.validation?.unstableCount || 0,
      dynamic: locatorGate.validation?.dynamic || null
    };
    result.steps[result.steps.length - 1].status = 'completed';

    result.steps.push({ id: 'generate-adapter', status: 'started', at: new Date().toISOString() });
    const adapter = await writeAdapterFromCapture(captureDir, {
      target: targetRoot,
      id: workflow.adapter.id,
      model: options.model,
      displayName: options.displayName,
      workerName: options.workerName,
      template: options.template,
      targetUrl: options.targetUrl,
      targetKind: options.targetKind
    });
    result.adapterPath = adapter.adapterPath;
    result.adapter = {
      id: adapter.adapterId,
      modelId: adapter.modelId,
      configSnippet: adapter.configSnippet
    };
    result.steps[result.steps.length - 1].status = 'completed';

    if (options.verify) {
      result.steps.push({ id: 'verify-adapter', status: 'started', at: new Date().toISOString() });
      result.verify = await verifyAdapter({
        adapterId: adapter.adapterId,
        target: targetRoot,
        prompt: options.verifyPrompt || options.aiInput || 'test',
        model: options.verifyModel || adapter.modelId,
        headless: options.verifyHeadless ?? options.headless ?? true,
        timeout: Number(options.verifyTimeout || 120000),
        userDataDir: options.verifyUserDataDir,
        browserPath: options.browserPath,
        windowSize: options.windowSize || DEFAULT_WINDOW_SIZE,
        visual: Boolean(options.visualVerify),
        visualOut: options.visualOut,
        captureDir,
        writeDiagnosis: Boolean(options.writeDiagnosis),
        slowMo: options.slowMo,
        pauseOnError: options.pauseOnError
      });
      result.steps[result.steps.length - 1].status = result.verify.ok ? 'completed' : 'failed';
    }

    result.completedAt = new Date().toISOString();
    result.ok = !result.verify || result.verify.ok;
    result.workflowArtifacts = await writeWorkflowArtifacts(captureDir, workflow, result);
    return { workflow, result };
  } catch (error) {
    result.completedAt = new Date().toISOString();
    result.ok = false;
    result.error = error.message;
    if (error.validation) {
      result.locatorValidation = {
        skipped: false,
        generated: false,
        minLocatorScore: error.validation.threshold,
        path: path.join(captureDir, 'locator-validation.json'),
        markdownPath: path.join(captureDir, 'locator-validation.md'),
        wroteInterface: false,
        ok: Boolean(error.validation.ok),
        locatorCount: error.validation.locatorCount || 0,
        minScore: error.validation.minScore || 0,
        averageScore: error.validation.averageScore || 0,
        unstableCount: error.validation.unstableCount || 0,
        dynamic: error.validation.dynamic || null
      };
    }
    if (result.steps.length) {
      result.steps[result.steps.length - 1].status = 'failed';
      result.steps[result.steps.length - 1].error = error.message;
    }
    result.workflowArtifacts = await writeWorkflowArtifacts(captureDir, workflow, result);
    throw Object.assign(error, { workflow, result });
  }
}
