#!/usr/bin/env node
import path from 'node:path';
import process from 'node:process';
import { buildInterfacePlan, loadCaptureBundle, writeInterfaceArtifacts } from './interfaceAnalyzer.js';

function printHelp() {
  console.log(`Usage:
  pnpm analyze <capture-dir> [--out <dir>]

Examples:
  pnpm analyze captures/action
  pnpm analyze captures/action --out captures/action/interface
`);
}

function parseArgs(argv) {
  const args = {
    captureDir: null,
    out: null,
    help: false
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      args.help = true;
    } else if (arg === '--out') {
      args.out = argv[++i];
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
  if (!args.captureDir) {
    printHelp();
    throw new Error('<capture-dir> is required');
  }

  const captureDir = path.resolve(args.captureDir);
  const outDir = path.resolve(args.out || args.captureDir);
  const bundle = await loadCaptureBundle(captureDir);
  const plan = buildInterfacePlan(bundle);
  await writeInterfaceArtifacts(plan, outDir);

  console.log(`Interface plan written:
  ${path.join(outDir, 'interface.json')}
  ${path.join(outDir, 'interface.md')}

Operation: ${plan.operation.name}
Confidence: ${plan.operation.confidence}/100
Warnings: ${plan.warnings.length}`);
}

main().catch(error => {
  console.error(`Error: ${error.message}`);
  process.exitCode = 1;
});
