#!/usr/bin/env node
import path from 'node:path';
import process from 'node:process';
import { verifyAdapter } from './adapterVerifier.js';
import { DEFAULT_WINDOW_SIZE, parseWindowSize } from './size.js';

function printHelp() {
  console.log(`Usage:
  pnpm verify-adapter <adapter_id> --prompt <text> [--target <WebAI2API-dir>] [--model <model-id>] [--headless] [--visual] [--visual-out <dir>] [--capture-dir <dir>] [--write-diagnosis] [--slow-mo 300] [--pause-on-error] [--timeout 120000] [--user-data-dir <dir>] [--browser-path <path>] [--window-size 1280x720]

Examples:
  pnpm verify-adapter bing_search_text --prompt "test" --target ../WebAI2API
  pnpm verify-adapter bing_search_text --prompt "test" --headless --timeout 60000
  pnpm verify-adapter bing_search_text --prompt "test" --visual --visual-out captures/verify/bing_search_text
`);
}

function parseArgs(argv) {
  const args = {
    adapterId: null,
    target: '../WebAI2API',
    prompt: null,
    model: null,
    headless: false,
    timeout: 120000,
    userDataDir: null,
    browserPath: null,
    windowSize: { ...DEFAULT_WINDOW_SIZE },
    visual: false,
    visualOut: null,
    captureDir: null,
    writeDiagnosis: false,
    slowMo: 0,
    pauseOnError: false,
    help: false
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      args.help = true;
    } else if (arg === '--target') {
      args.target = argv[++i];
    } else if (arg === '--prompt') {
      args.prompt = argv[++i];
    } else if (arg === '--model') {
      args.model = argv[++i];
    } else if (arg === '--headless') {
      args.headless = true;
    } else if (arg === '--visual') {
      args.visual = true;
    } else if (arg === '--visual-out') {
      args.visualOut = argv[++i];
    } else if (arg === '--capture-dir') {
      args.captureDir = argv[++i];
    } else if (arg === '--write-diagnosis') {
      args.writeDiagnosis = true;
    } else if (arg === '--slow-mo') {
      args.slowMo = Number(argv[++i]);
    } else if (arg === '--pause-on-error') {
      args.pauseOnError = true;
    } else if (arg === '--timeout') {
      args.timeout = Number(argv[++i]);
    } else if (arg === '--user-data-dir') {
      args.userDataDir = argv[++i];
    } else if (arg === '--browser-path') {
      args.browserPath = argv[++i];
    } else if (arg === '--window-size') {
      args.windowSize = parseWindowSize(argv[++i]);
    } else if (arg.startsWith('--')) {
      throw new Error(`Unknown option: ${arg}`);
    } else if (!args.adapterId) {
      args.adapterId = arg;
    } else {
      throw new Error(`Unexpected positional argument: ${arg}`);
    }
  }

  if (!Number.isFinite(args.timeout) || args.timeout <= 0) {
    throw new Error('--timeout must be a positive number');
  }
  if (!Number.isFinite(args.slowMo) || args.slowMo < 0) {
    throw new Error('--slow-mo must be zero or a positive number');
  }

  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }
  if (!args.adapterId || !args.prompt) {
    printHelp();
    throw new Error('<adapter_id> and --prompt are required');
  }

  const result = await verifyAdapter({
    adapterId: args.adapterId,
    target: path.resolve(args.target),
    prompt: args.prompt,
    model: args.model,
    headless: args.headless,
    timeout: args.timeout,
    userDataDir: args.userDataDir ? path.resolve(args.userDataDir) : null,
    browserPath: args.browserPath ? path.resolve(args.browserPath) : null,
    windowSize: args.windowSize,
    visual: args.visual,
    visualOut: args.visualOut ? path.resolve(args.visualOut) : null,
    captureDir: args.captureDir ? path.resolve(args.captureDir) : null,
    writeDiagnosis: args.writeDiagnosis,
    slowMo: args.slowMo,
    pauseOnError: args.pauseOnError
  });

  console.log(`Adapter verification ${result.ok ? 'passed' : 'failed'}:
  adapter: ${result.adapterId}
  model: ${result.modelId}
  elapsed: ${result.elapsedMs}ms
  text length: ${result.textLength}
  image length: ${result.imageLength}`);

  if (result.artifacts?.outDir) {
    console.log(`  visual artifacts: ${result.artifacts.outDir}`);
    if (result.artifacts.timelinePath) console.log(`  timeline: ${result.artifacts.timelinePath}`);
    if (result.artifacts.diagnosePath) console.log(`  diagnosis: ${result.artifacts.diagnosePath}`);
    if (result.artifacts.interfacePatchPath) console.log(`  interface patch: ${result.artifacts.interfacePatchPath}`);
    if (result.tracePath) console.log(`  trace: ${result.tracePath}`);
  }

  if (result.result?.error) {
    console.log(`  error: ${result.result.error}`);
    if (result.diagnosis?.type) {
      console.log(`  diagnosis type: ${result.diagnosis.type} (${Math.round(result.diagnosis.confidence * 100)}%)`);
    }
    process.exitCode = 1;
  } else if (result.result?.text) {
    const preview = String(result.result.text).replace(/\s+/g, ' ').trim().slice(0, 500);
    console.log(`  text preview: ${preview}`);
  } else if (result.result?.image) {
    console.log('  image: present');
  }
}

main().catch(error => {
  console.error(`Error: ${error.message}`);
  process.exitCode = 1;
});
