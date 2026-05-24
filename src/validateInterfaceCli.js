#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import {
  applyLocatorValidation,
  loadLocatorValidationInputs,
  validateInterfaceLocators,
  writeLocatorValidationArtifacts
} from './locatorValidator.js';
import {
  mergeDynamicLocatorValidation,
  runDynamicLocatorValidation
} from './dynamicLocatorValidator.js';

function printHelp() {
  console.log(`Usage:
  pnpm validate-interface <capture-dir> [--interface <interface.json>] [--out <dir>] [--write] [--min-score 70] [--strict] [--dynamic] [--headless] [--target-url <url>] [--fixture <path-or-url>] [--timeout 30000]

Examples:
  pnpm validate-interface captures/action
  pnpm validate-interface captures/action --write
  pnpm validate-interface captures/action --min-score 80 --strict
  pnpm validate-interface captures/action --dynamic --headless --timeout 30000
`);
}

function parseArgs(argv) {
  const args = {
    captureDir: null,
    interfacePath: null,
    out: null,
    minScore: 70,
    timeout: 30000,
    targetUrl: null,
    fixture: null,
    userDataDir: null,
    browserPath: null,
    write: false,
    strict: false,
    dynamic: false,
    headless: false,
    help: false
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') args.help = true;
    else if (arg === '--interface') args.interfacePath = argv[++i];
    else if (arg === '--out') args.out = argv[++i];
    else if (arg === '--min-score') args.minScore = Number(argv[++i]);
    else if (arg === '--timeout') args.timeout = Number(argv[++i]);
    else if (arg === '--target-url') args.targetUrl = argv[++i];
    else if (arg === '--fixture') args.fixture = argv[++i];
    else if (arg === '--user-data-dir') args.userDataDir = argv[++i];
    else if (arg === '--browser-path') args.browserPath = argv[++i];
    else if (arg === '--write') args.write = true;
    else if (arg === '--strict') args.strict = true;
    else if (arg === '--dynamic') args.dynamic = true;
    else if (arg === '--headless') args.headless = true;
    else if (arg.startsWith('--')) throw new Error(`Unknown option: ${arg}`);
    else if (!args.captureDir) args.captureDir = arg;
    else throw new Error(`Unexpected positional argument: ${arg}`);
  }

  if (!Number.isFinite(args.minScore) || args.minScore < 0 || args.minScore > 100) {
    throw new Error('--min-score must be between 0 and 100');
  }
  if (!Number.isFinite(args.timeout) || args.timeout <= 0) {
    throw new Error('--timeout must be a positive number');
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
  const { plan, profile, snapshots, interfacePath } = await loadLocatorValidationInputs(captureDir, {
    interfacePath: args.interfacePath
  });
  let validation = validateInterfaceLocators(plan, snapshots, { minScore: args.minScore });
  if (args.dynamic) {
    const dynamic = await runDynamicLocatorValidation(plan, profile, {
      minScore: args.minScore,
      timeout: args.timeout,
      targetUrl: args.targetUrl,
      fixture: args.fixture,
      userDataDir: args.userDataDir ? path.resolve(args.userDataDir) : null,
      browserPath: args.browserPath ? path.resolve(args.browserPath) : null,
      headless: args.headless
    });
    validation = mergeDynamicLocatorValidation(validation, dynamic);
  }
  const outDir = path.resolve(args.out || captureDir);
  const artifacts = await writeLocatorValidationArtifacts(validation, outDir);

  if (args.write) {
    const annotated = applyLocatorValidation(plan, validation);
    await fs.writeFile(interfacePath, JSON.stringify(annotated, null, 2), 'utf8');
  }

  console.log(`Locator validation written:
  ${artifacts.jsonPath}
  ${artifacts.mdPath}

Locators: ${validation.locatorCount}
Snapshots: ${validation.snapshotCount}
Average score: ${validation.averageScore}/100
Minimum score: ${validation.minScore}/100
${validation.dynamic?.enabled ? `Dynamic average score: ${validation.dynamic.averageScore}/100
Dynamic minimum score: ${validation.dynamic.minScore}/100
Dynamic URL: ${validation.dynamic.url}
` : ''}Status: ${validation.ok ? 'passed' : 'needs review'}`);

  if (args.strict && !validation.ok) process.exitCode = 2;
}

main().catch(error => {
  console.error(`Error: ${error.message}`);
  process.exitCode = 1;
});
