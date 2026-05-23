const JSON_SPACE = 2;

function compact(value, max = 240) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

export const WEBAI2API_CHATGPT_REFERENCE_PLAN = {
  schemaVersion: 'web-adapter-tools.adapter-plan.v1',
  id: 'webai2api-chatgpt-reference',
  title: 'WebAI2API Browser Adapter Plan from ChatGPT Adapters',
  summary: 'Reference plan extracted from WebAI2API chatgpt.js and chatgpt_text.js. It defines the interfaces and browser operations that an adapter capture should collect before code generation.',
  sourceAdapters: [
    'WebAI2API/src/backend/adapter/chatgpt.js',
    'WebAI2API/src/backend/adapter/chatgpt_text.js'
  ],
  captureObjective: [
    'Open the target website with a prepared browser profile.',
    'Find the primary prompt/input surface.',
    'Capture optional setup operations when present: model selector, temporary chat option, and upload entry.',
    'Enter the test prompt, submit it, and wait until the final user-visible result is produced.',
    'Record DOM events, before/after DOM diff, and network evidence for conversation/API/SSE/download endpoints.',
    'Preserve enough evidence to generate a WebAI2API adapter that returns { text }, { image }, or { error }.'
  ],
  moduleContract: {
    imports: [
      '../engine/utils.js: sleep, humanType, safeClick, uploadFilesViaChooser',
      '../utils/index.js: normalizePageError, waitForInput, gotoWithCheck, waitApiResponse, useContextDownload',
      '../../utils/logger.js: logger'
    ],
    constants: [
      'TARGET_URL: adapter entry page. chatgpt_text uses https://chatgpt.com/ or ?temporary-chat=true; chatgpt image uses https://chatgpt.com/images/.',
      'INPUT_SELECTOR: primary prompt editor; ChatGPT uses .ProseMirror.'
    ],
    generateSignature: 'async function generate(context, prompt, imgPaths, modelId, meta = {})',
    generateContext: [
      'context.page: Playwright Page controlled by the worker pool.',
      'context.config: WebAI2API config; pool waitTimeout and adapter-specific config are read here.'
    ],
    manifestFields: [
      'id',
      'displayName',
      'description',
      'configSchema when adapter has runtime options',
      'getTargetUrl(config, workerConfig)',
      'models with id/codeName/imagePolicy/type',
      'navigationHandlers',
      'generate'
    ],
    returnShape: [
      '{ text } for text adapters',
      '{ image } or downloaded image result for image adapters',
      '{ error, retryable?: false } for terminal page/API/model errors'
    ]
  },
  operations: [
    {
      id: 'navigate-target',
      title: 'Open target page',
      required: true,
      reference: ['chatgpt.js: gotoWithCheck(page, TARGET_URL)', 'chatgpt_text.js: gotoWithCheck(page, targetUrl)'],
      capture: [
        'Record the final loaded URL, page title, and initial network requests.',
        'If the page requires an existing login session, do not operate login controls; ask the human to prepare the profile.'
      ],
      codegenHints: ['TARGET_URL', 'getTargetUrl(config, workerConfig)', 'gotoWithCheck(page, targetUrl)']
    },
    {
      id: 'wait-input',
      title: 'Wait for primary input',
      required: true,
      reference: ['waitForInput(page, INPUT_SELECTOR, { click: false })'],
      capture: [
        'Identify the prompt editor/input locator.',
        'Prefer a stable role, label, placeholder, test id, or structural selector over a generated id.',
        'Confirm it is visible and editable before typing.'
      ],
      codegenHints: ['INPUT_SELECTOR', 'waitForInput']
    },
    {
      id: 'select-model',
      title: 'Optional model selection',
      required: false,
      reference: [
        "page.getByRole('button', { name: /^Model selector/ })",
        "page.getByRole('menuitem', { name: /^Legacy models/ })",
        "page.getByRole('menuitemradio'|'menuitem', { name: /^<codeName>/i })"
      ],
      capture: [
        'Only capture this branch when the page exposes a model selector or the requested adapter needs multiple models.',
        'Record the selector button, optional submenu, final model option, and model codeName text.',
        'If model selection is unavailable, keep the adapter on the default model.'
      ],
      codegenHints: ['manifest.models[].codeName', 'selectModel(page, codeName, meta)']
    },
    {
      id: 'upload-files',
      title: 'Optional file/image upload',
      required: false,
      reference: [
        "page.getByRole('button', { name: 'Add files and more' })",
        'uploadFilesViaChooser(page, addFilesBtn, imgPaths, options, meta)',
        "backend-api/files",
        "backend-api/files/process_upload_stream"
      ],
      capture: [
        'Only use safe local test files supplied by the user or verification script.',
        'Record upload entry locator, file chooser behavior, and network endpoints that prove upload and processing are complete.',
        'For ChatGPT text, the reference uses dblclick; for image, the reference uses the default click action.'
      ],
      codegenHints: ['imgPaths', 'uploadFilesViaChooser', 'uploadValidator']
    },
    {
      id: 'enter-prompt',
      title: 'Enter prompt',
      required: true,
      reference: ['safeClick(page, INPUT_SELECTOR, { bias: "input" })', 'humanType(page, INPUT_SELECTOR, prompt)'],
      capture: [
        'Click/focus the input and type the test aiInput/prompt.',
        'Record input/input-snapshot/change events so interface analysis can infer the parameter name and locator.'
      ],
      codegenHints: ['prompt', 'safeClick', 'humanType']
    },
    {
      id: 'prepare-output-wait',
      title: 'Prepare output wait before submit',
      required: true,
      reference: [
        'chatgpt_text.js starts page.waitForResponse before pressing Enter to avoid an SSE race.',
        'chatgpt.js waits for backend-api/f/conversation after submit for image generation.'
      ],
      capture: [
        'Identify the reliable completion signal before final codegen: DOM output, POST response, SSE stream, file status endpoint, or download endpoint.',
        'Record network endpoints around submission, especially fetch/xhr/document requests with conversation/chat/generate/message semantics.'
      ],
      codegenHints: ['page.waitForResponse', 'waitApiResponse', 'waitTimeout']
    },
    {
      id: 'submit-prompt',
      title: 'Submit prompt',
      required: true,
      reference: ['page.keyboard.press("Enter")', "send button role name 'Send prompt' is kept as a locator fallback"],
      capture: [
        'Submit with Enter or a stable send button.',
        'Record the submit event or key event, plus the target locator used for submission.'
      ],
      codegenHints: ['page.keyboard.press("Enter")', 'send button fallback']
    },
    {
      id: 'extract-text',
      title: 'Text result extraction',
      required: false,
      reference: [
        "POST backend-api/f/conversation",
        'Parse SSE data: lines.',
        'Track assistant message with channel=final and content_type=text.',
        'Append patches at /message/content/parts/0.',
        'Finish on [DONE], finished_successfully, or message_stream_complete.'
      ],
      capture: [
        'For text adapters, wait until the final answer is visible or the response stream is complete.',
        'Record output DOM locator and network response evidence when available.',
        'Ignore commentary/thinking channels when a site exposes them separately.'
      ],
      codegenHints: ['return { text: textContent.trim() }']
    },
    {
      id: 'extract-image',
      title: 'Image result extraction',
      required: false,
      reference: [
        "POST backend-api/f/conversation",
        "backend-api/files/download/file_",
        'JSON fields file_name and download_url',
        'useContextDownload(downloadUrl, page, { retries })'
      ],
      capture: [
        'For image adapters, detect that generation started, then wait for a generated file/download URL.',
        "Ignore partial files; ChatGPT checks file_name starts with 'user-' and does not include '.part'.",
        'Download or preserve the URL using the WebAI2API browser context.'
      ],
      codegenHints: ['return image download result', 'useContextDownload']
    },
    {
      id: 'error-detection',
      title: 'Failure and terminal error detection',
      required: true,
      reference: [
        'normalizePageError(err, meta)',
        'HTTP status checks',
        'RateLimitException/rate limit detection',
        'content rejection text detection',
        'empty text detection'
      ],
      capture: [
        'Record visible login/captcha/verification/empty-result/error states without operating risky controls.',
        'Record failed HTTP statuses and timeout boundaries.',
        'Return retryable=false for deterministic model/account/policy/rate-limit failures.'
      ],
      codegenHints: ['normalizePageError', '{ error, retryable: false }']
    }
  ],
  captureRequirements: {
    dom: [
      'before/after snapshots around the full generate operation',
      'input locator evidence',
      'submit locator or Enter key evidence',
      'output locator evidence'
    ],
    events: [
      'focus/click/input/change/key/submit/file-change events produced by the operation'
    ],
    network: [
      'submission request URL/method/status/resourceType',
      'stream or completion response signal',
      'upload processing endpoints when files are used',
      'download/file status endpoints when images/files are produced'
    ],
    controller: [
      'AI decisions with confidence',
      'human fallback instructions and completion signals',
      'final completion or failure reason'
    ]
  },
  aiInstructions: [
    'Complete only safe browser actions that are necessary to exercise the adapter generate flow.',
    'Do not click login, captcha, payment, account, delete, authorization, or password controls.',
    'If login/profile/setup is required, ask the human for assistance with a concise instruction.',
    'Use the provided aiInput as the prompt text.',
    'Finish only after the final output or a clear terminal error is visible or observable.'
  ]
};

const BUILT_IN_PLANS = new Map([
  [WEBAI2API_CHATGPT_REFERENCE_PLAN.id, WEBAI2API_CHATGPT_REFERENCE_PLAN],
  ['chatgpt-reference', WEBAI2API_CHATGPT_REFERENCE_PLAN],
  ['webai2api-common', WEBAI2API_CHATGPT_REFERENCE_PLAN]
]);

export function listBuiltInAdapterPlans() {
  return Array.from(new Set(Array.from(BUILT_IN_PLANS.values()).map(plan => plan.id)));
}

export function getBuiltInAdapterPlan(id = WEBAI2API_CHATGPT_REFERENCE_PLAN.id) {
  const plan = BUILT_IN_PLANS.get(id);
  if (!plan) {
    throw new Error(`Unknown adapter plan "${id}". Available plans: ${listBuiltInAdapterPlans().join(', ')}`);
  }
  return clone(plan);
}

export function compactAdapterPlanForAi(plan) {
  if (!plan) return null;
  return {
    id: plan.id,
    title: plan.title,
    captureObjective: (plan.captureObjective || []).map(item => compact(item, 180)),
    requiredInterfaces: {
      generateSignature: plan.moduleContract?.generateSignature || '',
      manifestFields: plan.moduleContract?.manifestFields || [],
      returnShape: plan.moduleContract?.returnShape || []
    },
    operations: (plan.operations || []).map(operation => ({
      id: operation.id,
      title: operation.title,
      required: Boolean(operation.required),
      capture: (operation.capture || []).map(item => compact(item, 220)),
      codegenHints: operation.codegenHints || []
    })),
    captureRequirements: plan.captureRequirements || {},
    aiInstructions: plan.aiInstructions || []
  };
}

export function buildAiGoalFromAdapterPlan(plan, options = {}) {
  const inputText = options.aiInput ? ` Use the test prompt: "${compact(options.aiInput, 160)}".` : '';
  const extraGoal = options.aiGoal ? ` User goal override/addition: ${compact(options.aiGoal, 300)}.` : '';
  const requiredOps = (plan.operations || [])
    .filter(operation => operation.required)
    .map(operation => operation.title)
    .join(' -> ');
  const optionalOps = (plan.operations || [])
    .filter(operation => !operation.required)
    .map(operation => operation.title)
    .join('; ');
  return [
    `Capture the target website's WebAI2API adapter generate flow according to adapter plan "${plan.id}".`,
    requiredOps ? `Required operation chain: ${requiredOps}.` : '',
    optionalOps ? `Capture optional branches only when present and safe: ${optionalOps}.` : '',
    'Collect enough evidence for input, submit, output, network completion, and error handling.',
    inputText,
    extraGoal
  ].filter(Boolean).join(' ');
}

export function defaultMaxStepsForAdapterPlan(plan) {
  const operationCount = (plan?.operations || []).length;
  if (!operationCount) return 8;
  return Math.max(8, Math.min(16, operationCount + 2));
}

export function renderAdapterPlanMarkdown(plan) {
  const lines = [];
  lines.push(`# ${plan.title}`);
  lines.push('');
  lines.push(plan.summary);
  lines.push('');
  lines.push(`Plan id: \`${plan.id}\``);
  lines.push('');
  lines.push('## Source Adapters');
  for (const source of plan.sourceAdapters || []) lines.push(`- \`${source}\``);
  lines.push('');
  lines.push('## Module Interfaces');
  lines.push(`- Generate signature: \`${plan.moduleContract.generateSignature}\``);
  lines.push('- Imports:');
  for (const item of plan.moduleContract.imports || []) lines.push(`  - \`${item}\``);
  lines.push('- Constants:');
  for (const item of plan.moduleContract.constants || []) lines.push(`  - ${item}`);
  lines.push('- Context:');
  for (const item of plan.moduleContract.generateContext || []) lines.push(`  - ${item}`);
  lines.push('- Manifest fields:');
  for (const item of plan.moduleContract.manifestFields || []) lines.push(`  - \`${item}\``);
  lines.push('- Return shape:');
  for (const item of plan.moduleContract.returnShape || []) lines.push(`  - \`${item}\``);
  lines.push('');
  lines.push('## Operation Capture Plan');
  for (const operation of plan.operations || []) {
    lines.push(`### ${operation.required ? 'Required' : 'Optional'}: ${operation.title}`);
    lines.push('');
    lines.push(`Operation id: \`${operation.id}\``);
    lines.push('');
    lines.push('Reference:');
    for (const item of operation.reference || []) lines.push(`- \`${item}\``);
    lines.push('');
    lines.push('Capture requirements:');
    for (const item of operation.capture || []) lines.push(`- ${item}`);
    lines.push('');
    lines.push('Code generation hints:');
    for (const item of operation.codegenHints || []) lines.push(`- \`${item}\``);
    lines.push('');
  }
  lines.push('## Required Capture Evidence');
  for (const [group, items] of Object.entries(plan.captureRequirements || {})) {
    lines.push(`- ${group}: ${(items || []).join('; ')}`);
  }
  lines.push('');
  lines.push('## AI Capture Rules');
  for (const item of plan.aiInstructions || []) lines.push(`- ${item}`);
  lines.push('');
  return lines.join('\n');
}

export function stringifyAdapterPlan(plan) {
  return JSON.stringify(plan, null, JSON_SPACE);
}
