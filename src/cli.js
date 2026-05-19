#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { collectPageProfile, defaultUserDataDir } from './collector.js';
import { DEFAULT_WINDOW_SIZE, parseWindowSize } from './size.js';
import { writeCaptureArtifacts } from './artifacts.js';

function printHelp() {
  console.log(`Usage:
  pnpm collect <url> --out <dir> [--user-data-dir <dir>] [--interactive] [--record-action] [--browser-controls] [--action-count 1] [--headless] [--timeout 60000] [--browser-path <path>] [--window-size 1280x720]

Examples:
  pnpm collect https://example.com/app --out captures/example
  pnpm collect https://example.com/app --out captures/private --interactive --user-data-dir profiles/example
  pnpm collect https://example.com/app --out captures/action --record-action --user-data-dir profiles/example
  pnpm collect https://example.com/app --out captures/action --record-action --browser-controls --user-data-dir profiles/example
  pnpm collect https://example.com/app --out captures/action --record-action --action-count 3 --user-data-dir profiles/example
  pnpm collect https://example.com/app --out captures/example --window-size 1366x768
`);
}

function parseArgs(argv) {
  const args = {
    url: null,
    out: null,
    userDataDir: defaultUserDataDir(),
    interactive: false,
    recordAction: false,
    browserControls: false,
    actionCount: null,
    headless: false,
    timeout: 60000,
    browserPath: null,
    windowSize: { ...DEFAULT_WINDOW_SIZE }
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      args.help = true;
    } else if (arg === '--out') {
      args.out = argv[++i];
    } else if (arg === '--user-data-dir') {
      args.userDataDir = argv[++i];
    } else if (arg === '--interactive') {
      args.interactive = true;
    } else if (arg === '--record-action') {
      args.recordAction = true;
    } else if (arg === '--browser-controls') {
      args.browserControls = true;
      args.recordAction = true;
      args.interactive = true;
    } else if (arg === '--action-count') {
      args.actionCount = Number(argv[++i]);
    } else if (arg === '--headless') {
      args.headless = true;
    } else if (arg === '--timeout') {
      args.timeout = Number(argv[++i]);
    } else if (arg === '--browser-path') {
      args.browserPath = argv[++i];
    } else if (arg === '--window-size') {
      args.windowSize = parseWindowSize(argv[++i]);
    } else if (arg.startsWith('--')) {
      throw new Error(`Unknown option: ${arg}`);
    } else if (!args.url) {
      args.url = arg;
    } else {
      throw new Error(`Unexpected positional argument: ${arg}`);
    }
  }

  if (!Number.isFinite(args.timeout) || args.timeout <= 0) {
    throw new Error('--timeout must be a positive number');
  }
  if (args.actionCount !== null && (!Number.isInteger(args.actionCount) || args.actionCount <= 0)) {
    throw new Error('--action-count must be a positive integer');
  }
  if (args.browserControls && args.headless) {
    throw new Error('--browser-controls requires a headed browser. Remove --headless.');
  }

  return args;
}

async function waitForEnter(page, phase, meta = {}) {
  if (phase === 'record-action') {
    const suffix = meta.actionCount > 1 ? ` (${meta.actionIndex}/${meta.actionCount})` : '';
    console.log(`Manual action recording is now active.
Perform target action${suffix} in the browser, such as typing a test prompt and submitting it.
Do not log in, solve captchas, or perform sensitive account actions as part of this step.
Current page: ${page.url()}
Press Enter here after the page has produced the result you want captured.`);
  } else {
    console.log(`Interactive mode enabled.
Navigate or log in manually in the opened browser window.
Current page: ${page.url()}
Press Enter here when the page is ready to profile.`);
  }
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
  if (!args.url || !args.out) {
    printHelp();
    throw new Error('Both <url> and --out <dir> are required');
  }

  const outDir = path.resolve(args.out);
  const profile = await collectPageProfile({
    url: args.url,
    userDataDir: path.resolve(args.userDataDir),
    headless: args.headless,
    timeout: args.timeout,
    browserPath: args.browserPath ? path.resolve(args.browserPath) : null,
    windowSize: args.windowSize,
    interactive: args.interactive || args.recordAction,
    recordAction: args.recordAction,
    browserControls: args.browserControls,
    actionCount: args.actionCount || (args.browserControls ? 20 : 1),
    waitForUser: (args.interactive || args.recordAction) ? waitForEnter : null
  });

  await fs.mkdir(outDir, { recursive: true });
  const index = await writeCaptureArtifacts(profile, outDir);

  console.log(`Profile written:
  ${path.join(outDir, 'profile.json')} (index)
  ${path.join(outDir, index.files.capture)}
  ${path.join(outDir, index.files.page)}
  ${path.join(outDir, index.files.elements)}
  ${path.join(outDir, index.files.recommendations)}
  ${path.join(outDir, index.files.network)}
  ${index.files.actionSegments ? path.join(outDir, index.files.actionSegments) : ''}
  ${path.join(outDir, index.files.html)}`);
}

main().catch(error => {
  console.error(`Error: ${error.message}`);
  process.exitCode = 1;
});
