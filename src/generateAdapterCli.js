#!/usr/bin/env node
import path from 'node:path';
import process from 'node:process';
import { ensureLocatorValidationGate, writeAdapterFromCapture } from './adapterGenerator.js';

function printHelp() {
  console.log(`Usage:
  pnpm generate-adapter <capture-dir> --target <WebAI2API-dir> --id <adapter_id> [--target-kind webai2api|web2web-sidecar] [--model <model-id>] [--display-name <name>] [--worker-name <name>] [--template search_text] [--min-locator-score 70] [--write-validation] [--force]

Examples:
  pnpm generate-adapter captures/action --target ../WebAI2API --id bing_search_text --model bing-search --display-name "Bing Search"
  pnpm generate-adapter captures/action --target ../server --target-kind web2web-sidecar --id bing_search_text --model bing-search --display-name "Bing Search"
`);
}

function parseArgs(argv) {
  const args = {
    captureDir: null,
    target: null,
    id: null,
    model: null,
    displayName: null,
    workerName: null,
    template: null,
    targetUrl: null,
    targetKind: 'webai2api',
    minLocatorScore: 70,
    writeValidation: false,
    force: false,
    help: false
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      args.help = true;
    } else if (arg === '--target') {
      args.target = argv[++i];
    } else if (arg === '--id') {
      args.id = argv[++i];
    } else if (arg === '--model') {
      args.model = argv[++i];
    } else if (arg === '--display-name') {
      args.displayName = argv[++i];
    } else if (arg === '--worker-name') {
      args.workerName = argv[++i];
    } else if (arg === '--template') {
      args.template = argv[++i];
    } else if (arg === '--target-url') {
      args.targetUrl = argv[++i];
    } else if (arg === '--target-kind') {
      args.targetKind = argv[++i];
    } else if (arg === '--min-locator-score') {
      args.minLocatorScore = Number(argv[++i]);
    } else if (arg === '--write-validation') {
      args.writeValidation = true;
    } else if (arg === '--force') {
      args.force = true;
    } else if (arg.startsWith('--')) {
      throw new Error(`Unknown option: ${arg}`);
    } else if (!args.captureDir) {
      args.captureDir = arg;
    } else {
      throw new Error(`Unexpected positional argument: ${arg}`);
    }
  }

  if (!Number.isFinite(args.minLocatorScore) || args.minLocatorScore < 0 || args.minLocatorScore > 100) {
    throw new Error('--min-locator-score must be between 0 and 100');
  }

  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }
  if (!args.captureDir || !args.target || !args.id) {
    printHelp();
    throw new Error('<capture-dir>, --target, and --id are required');
  }

  const captureDir = path.resolve(args.captureDir);
  const locatorGate = await ensureLocatorValidationGate(captureDir, {
    minLocatorScore: args.minLocatorScore,
    writeValidation: args.writeValidation,
    force: args.force
  });

  if (locatorGate.skipped) {
    console.warn(`Locator validation skipped by --force (minimum score ${locatorGate.minLocatorScore}/100).`);
  } else {
    console.log(`Locator validation ${locatorGate.generated ? 'generated' : 'loaded'}:
  ${locatorGate.validationPath}
  Minimum required score: ${locatorGate.minLocatorScore}/100
  Current minimum score: ${locatorGate.validation.minScore}/100
  Status: passed${locatorGate.wroteInterface ? '\n  interface.json annotated with validation metadata' : ''}`);
  }

  const result = await writeAdapterFromCapture(captureDir, {
    target: path.resolve(args.target),
    id: args.id,
    model: args.model,
    displayName: args.displayName,
    workerName: args.workerName,
    template: args.template,
    targetUrl: args.targetUrl,
    targetKind: args.targetKind
  });

  console.log(`Adapter written:
  ${result.adapterPath}

Target kind: ${result.targetKind}
Adapter id: ${result.adapterId}
Model id: ${result.modelId}

Configure worker type as:
  type: ${result.adapterId}

Config snippet:
${result.configSnippet}`);
}

main().catch(error => {
  console.error(`Error: ${error.message}`);
  process.exitCode = 1;
});
