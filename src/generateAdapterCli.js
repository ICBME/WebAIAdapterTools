#!/usr/bin/env node
import path from 'node:path';
import process from 'node:process';
import { writeAdapterFromCapture } from './adapterGenerator.js';

function printHelp() {
  console.log(`Usage:
  pnpm generate-adapter <capture-dir> --target <WebAI2API-dir> --id <adapter_id> [--model <model-id>] [--display-name <name>] [--worker-name <name>] [--template search_text]

Examples:
  pnpm generate-adapter captures/action --target ../WebAI2API --id bing_search_text --model bing-search --display-name "Bing Search"
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
    } else if (arg.startsWith('--')) {
      throw new Error(`Unknown option: ${arg}`);
    } else if (!args.captureDir) {
      args.captureDir = arg;
    } else {
      throw new Error(`Unexpected positional argument: ${arg}`);
    }
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

  const result = await writeAdapterFromCapture(path.resolve(args.captureDir), {
    target: path.resolve(args.target),
    id: args.id,
    model: args.model,
    displayName: args.displayName,
    workerName: args.workerName,
    template: args.template,
    targetUrl: args.targetUrl
  });

  console.log(`Adapter written:
  ${result.adapterPath}

Adapter id: ${result.adapterId}
Model id: ${result.modelId}

Configure WebAI2API worker type as:
  type: ${result.adapterId}

Config snippet:
${result.configSnippet}`);
}

main().catch(error => {
  console.error(`Error: ${error.message}`);
  process.exitCode = 1;
});
