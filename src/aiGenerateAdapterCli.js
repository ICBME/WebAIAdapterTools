#!/usr/bin/env node
import path from 'node:path';
import process from 'node:process';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { runAiAdapterWorkflow } from './adapterWorkflow.js';
import { defaultUserDataDir } from './collector.js';
import { DEFAULT_WINDOW_SIZE, parseWindowSize } from './size.js';

function printHelp() {
  console.log(`Usage:
  pnpm ai-generate-adapter <url> --out <capture-dir> --target <WebAI2API-dir> --id <adapter_id> [--target-kind webai2api|web2web-sidecar] [--plan webai2api-chatgpt-reference] [--ai-goal <text>] [--ai-input <text>] [--ai-provider raw|langgraph] [--ai-mode hybrid] [--model <model-id>] [--display-name <name>] [--verify]

Examples:
  pnpm ai-generate-adapter https://example.com/app --out captures/example-ai --target ../WebAI2API --id example_text --plan webai2api-chatgpt-reference --ai-input "hello"
  pnpm ai-generate-adapter https://bing.com --out captures/bing-ai --target ../WebAI2API --id bing_search_text --plan webai2api-chatgpt-reference --ai-goal "search for the test query and wait for results" --ai-input "test query" --ai-provider langgraph --browser-controls --verify
  pnpm ai-generate-adapter https://bing.com --out captures/bing-ai --target ../server --target-kind web2web-sidecar --id bing_search_text --ai-input "test query"
`);
}

function parseArgs(argv) {
  const args = {
    url: null,
    out: null,
    target: null,
    id: null,
    model: null,
    displayName: null,
    workerName: null,
    template: null,
    targetUrl: null,
    targetKind: 'webai2api',
    plan: process.env.WEBADAPTERTOOLS_ADAPTER_PLAN || 'webai2api-chatgpt-reference',
    userDataDir: defaultUserDataDir(),
    headless: false,
    timeout: 60000,
    browserPath: null,
    windowSize: { ...DEFAULT_WINDOW_SIZE },
    browserControls: false,
    aiGoal: '',
    aiInput: '',
    aiMode: 'hybrid',
    aiProvider: process.env.WEBADAPTERTOOLS_AI_PROVIDER || 'raw',
    aiTimeout: Number(process.env.WEBADAPTERTOOLS_AI_TIMEOUT || 180000),
    aiMaxSteps: null,
    aiModel: null,
    aiMinConfidence: 0.7,
    verify: false,
    verifyPrompt: null,
    verifyModel: null,
    verifyTimeout: 120000,
    visualVerify: false,
    visualOut: null,
    slowMo: 0,
    pauseOnError: false,
    help: false
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') args.help = true;
    else if (arg === '--out') args.out = argv[++i];
    else if (arg === '--target') args.target = argv[++i];
    else if (arg === '--id') args.id = argv[++i];
    else if (arg === '--model') args.model = argv[++i];
    else if (arg === '--display-name') args.displayName = argv[++i];
    else if (arg === '--worker-name') args.workerName = argv[++i];
    else if (arg === '--template') args.template = argv[++i];
    else if (arg === '--target-url') args.targetUrl = argv[++i];
    else if (arg === '--target-kind') args.targetKind = argv[++i];
    else if (arg === '--plan') args.plan = argv[++i];
    else if (arg === '--no-plan') args.plan = 'none';
    else if (arg === '--user-data-dir') args.userDataDir = argv[++i];
    else if (arg === '--headless') args.headless = true;
    else if (arg === '--timeout') args.timeout = Number(argv[++i]);
    else if (arg === '--browser-path') args.browserPath = argv[++i];
    else if (arg === '--window-size') args.windowSize = parseWindowSize(argv[++i]);
    else if (arg === '--browser-controls') args.browserControls = true;
    else if (arg === '--ai-goal') args.aiGoal = argv[++i];
    else if (arg === '--ai-input') args.aiInput = argv[++i];
    else if (arg === '--ai-mode') args.aiMode = argv[++i];
    else if (arg === '--ai-provider') args.aiProvider = argv[++i];
    else if (arg === '--ai-timeout') args.aiTimeout = Number(argv[++i]);
    else if (arg === '--ai-max-steps') args.aiMaxSteps = Number(argv[++i]);
    else if (arg === '--ai-model') args.aiModel = argv[++i];
    else if (arg === '--ai-min-confidence') args.aiMinConfidence = Number(argv[++i]);
    else if (arg === '--verify') args.verify = true;
    else if (arg === '--verify-prompt') args.verifyPrompt = argv[++i];
    else if (arg === '--verify-model') args.verifyModel = argv[++i];
    else if (arg === '--verify-timeout') args.verifyTimeout = Number(argv[++i]);
    else if (arg === '--visual-verify') args.visualVerify = true;
    else if (arg === '--visual-out') args.visualOut = argv[++i];
    else if (arg === '--slow-mo') args.slowMo = Number(argv[++i]);
    else if (arg === '--pause-on-error') args.pauseOnError = true;
    else if (arg.startsWith('--')) throw new Error(`Unknown option: ${arg}`);
    else if (!args.url) args.url = arg;
    else throw new Error(`Unexpected positional argument: ${arg}`);
  }

  if (!args.help) {
    if (!args.url || !args.out || !args.target || !args.id || (!args.aiGoal && args.plan === 'none')) {
      printHelp();
      throw new Error('<url>, --out, --target, --id are required. Use --ai-goal when --no-plan is set.');
    }
    if (!['auto', 'assist', 'hybrid'].includes(args.aiMode)) throw new Error('--ai-mode must be auto, assist, or hybrid');
    if (!['raw', 'langgraph'].includes(args.aiProvider)) throw new Error('--ai-provider must be raw or langgraph');
    for (const [name, value] of [
      ['--timeout', args.timeout],
      ['--ai-timeout', args.aiTimeout],
      ['--verify-timeout', args.verifyTimeout]
    ]) {
      if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive number`);
    }
    if (args.aiMaxSteps !== null && (!Number.isInteger(args.aiMaxSteps) || args.aiMaxSteps <= 0)) throw new Error('--ai-max-steps must be a positive integer');
    if (!Number.isFinite(args.aiMinConfidence) || args.aiMinConfidence < 0 || args.aiMinConfidence > 1) {
      throw new Error('--ai-min-confidence must be a number between 0 and 1');
    }
  }

  return args;
}

async function waitForEnter(page, phase, meta = {}) {
  if (phase !== 'ai-assist') return;
  console.log(`AI needs human assistance.
Instruction:
${meta.instruction}

Current page: ${page.url()}
Press Enter after you finish this step.`);
  const rl = readline.createInterface({ input, output });
  await rl.question('');
  rl.close();
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }

  const { result } = await runAiAdapterWorkflow({
    ...args,
    out: path.resolve(args.out),
    target: path.resolve(args.target),
    userDataDir: path.resolve(args.userDataDir),
    browserPath: args.browserPath ? path.resolve(args.browserPath) : null,
    visualOut: args.visualOut ? path.resolve(args.visualOut) : null,
    waitForUser: waitForEnter
  });

  console.log(`AI adapter workflow ${result.ok ? 'completed' : 'finished with errors'}:
  capture: ${result.captureIndexPath}
  interface: ${result.interfacePath}
  adapter: ${result.adapterPath}
  workflow: ${result.workflowArtifacts?.mdPath}
  plan: ${result.workflowArtifacts?.planMdPath || '(disabled)'}

Adapter id: ${result.adapter?.id}
Model id: ${result.adapter?.modelId}

Config snippet:
${result.adapter?.configSnippet || ''}`);

  if (!result.ok) process.exitCode = 1;
}

main().catch(error => {
  console.error(`Error: ${error.message}`);
  if (error.result?.workflowArtifacts?.mdPath) {
    console.error(`Workflow log: ${error.result.workflowArtifacts.mdPath}`);
  }
  process.exitCode = 1;
});
