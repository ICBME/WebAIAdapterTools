import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { attachNetworkRecorder } from './networkRecorder.js';
import { collectPageSnapshot } from './pageProfile.js';
import { sanitizeUrl } from './url.js';
import { assertCompatibleDependencyVersions } from './versionGuard.js';
import { diffSnapshots } from './actionDiff.js';
import { DEFAULT_WINDOW_SIZE } from './size.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');

export function defaultUserDataDir() {
  return path.join(PROJECT_ROOT, '.profiles', 'default');
}

async function loadCamoufox() {
  try {
    return await import('camoufox-js');
  } catch (error) {
    throw new Error(`camoufox-js is not installed. Run "pnpm install" in WebAdapterTools. Original error: ${error.message}`);
  }
}

export async function collectPageProfile(options) {
  const {
    url,
    userDataDir = defaultUserDataDir(),
    headless = false,
    timeout = 60000,
    browserPath,
    windowSize = DEFAULT_WINDOW_SIZE,
    interactive = false,
    recordAction = false,
    waitForUser
  } = options;

  if (!url) throw new Error('Missing target URL');
  assertCompatibleDependencyVersions();

  const { Camoufox } = await loadCamoufox();
  const fixedWindow = [
    Number(windowSize?.width || DEFAULT_WINDOW_SIZE.width),
    Number(windowSize?.height || DEFAULT_WINDOW_SIZE.height)
  ];
  const context = await Camoufox({
    headless,
    user_data_dir: userDataDir,
    executable_path: browserPath || undefined,
    window: fixedWindow,
    args: [`--width=${fixedWindow[0]}`, `--height=${fixedWindow[1]}`],
    i_know_what_im_doing: true
  });

  try {
    const page = context.pages()[0] || await context.newPage();
    await page.setViewportSize({ width: fixedWindow[0], height: fixedWindow[1] }).catch(() => {});
    const networkRecorder = attachNetworkRecorder(page);
    await page.goto(url, { waitUntil: 'load', timeout }).catch(error => {
      throw new Error(`Navigation failed: ${error.message}`);
    });

    if ((interactive || recordAction) && waitForUser) {
      await waitForUser(page, 'prepare');
    }

    const viewport = page.viewportSize();
    const profile = await collectPageSnapshot(page, {
      initialUrl: sanitizeUrl(url),
      finalUrl: sanitizeUrl(page.url()),
      capturedAt: new Date().toISOString(),
      viewport,
      options: {
        headless,
        interactive,
        recordAction,
        timeout,
        userDataDir,
        browserPath: browserPath || null,
        windowSize: { width: fixedWindow[0], height: fixedWindow[1] }
      }
    });

    if (recordAction && waitForUser) {
      const beforeAction = profile;
      const initialNetwork = networkRecorder.getSummary();
      networkRecorder.reset();
      await waitForUser(page, 'record-action');
      await page.waitForLoadState('networkidle', { timeout: Math.min(timeout, 30000) }).catch(() => {});
      const afterAction = await collectPageSnapshot(page, {
        initialUrl: sanitizeUrl(url),
        finalUrl: sanitizeUrl(page.url()),
        capturedAt: new Date().toISOString(),
        viewport: page.viewportSize(),
        options: {
          headless,
          interactive,
          recordAction,
          timeout,
          userDataDir,
          browserPath: browserPath || null,
          windowSize: { width: fixedWindow[0], height: fixedWindow[1] }
        },
        phase: 'afterAction'
      });
      profile.actionCapture = {
        mode: 'manual',
        instructions: 'User manually performed the target action. Tool only captured DOM/network changes.',
        before: {
          page: beforeAction.page,
          recommendations: beforeAction.recommendations
        },
        after: {
          page: afterAction.page,
          recommendations: afterAction.recommendations
        },
        diff: diffSnapshots(beforeAction, afterAction),
        network: networkRecorder.getSummary()
      };
      profile.network = initialNetwork;
    } else {
      profile.network = networkRecorder.getSummary();
    }
    return profile;
  } finally {
    await context.close().catch(() => {});
  }
}
