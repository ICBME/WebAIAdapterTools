import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { attachNetworkRecorder } from './networkRecorder.js';
import { collectPageSnapshot } from './pageProfile.js';
import { sanitizeUrl, summarizeUrlList } from './url.js';
import { assertCompatibleDependencyVersions } from './versionGuard.js';
import { diffSnapshots } from './actionDiff.js';
import { DEFAULT_WINDOW_SIZE } from './size.js';
import { installActionRecorder } from './actionRecorder.js';
import { installBrowserControls } from './browserControls.js';
import { runAiHybridAction } from './ai/controller.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');

export function defaultUserDataDir() {
  return path.join(PROJECT_ROOT, '.profiles', 'default');
}

function snapshotParts(snapshot) {
  return {
    page: snapshot.page,
    elements: snapshot.elements,
    recommendations: snapshot.recommendations
  };
}

function captureOptions({ headless, interactive, recordAction, browserControls, actionCount, timeout, userDataDir, browserPath, fixedWindow, networkSchema }) {
  return {
    headless,
    interactive,
    recordAction,
    browserControls,
    actionCount,
    timeout,
    networkSchema,
    userDataDir,
    browserPath: browserPath || null,
    windowSize: { width: fixedWindow[0], height: fixedWindow[1] }
  };
}

function aggregateSegmentNetwork(segments) {
  let nextId = 1;
  const requests = [];
  for (const segment of segments) {
    for (const request of segment.network?.requests || []) {
      requests.push({
        ...request,
        id: nextId++,
        sourceRequestId: request.id,
        actionId: segment.id,
        actionLabel: segment.label
      });
    }
  }
  return {
    summary: summarizeUrlList(requests),
    requests
  };
}

function aggregateSegmentEvents(segments) {
  let nextSeq = 1;
  const events = [];
  for (const segment of segments) {
    for (const event of segment.events || []) {
      events.push({
        ...event,
        seq: nextSeq++,
        sourceSeq: event.seq,
        actionId: segment.id,
        actionLabel: segment.label
      });
    }
  }
  return events;
}

function buildActionCapture({ mode, actionRecorder, segments }) {
  const first = segments[0];
  const last = segments[segments.length - 1];
  const before = first?.before || null;
  const after = last?.after || null;
  const events = aggregateSegmentEvents(segments);
  return {
    mode,
    instructions: 'User manually performed target actions. Tool captured safe DOM event metadata, before/after snapshots, per-action DOM diffs, and per-action network metadata.',
    recorderInstalled: actionRecorder.isInstalled(),
    recorderInstallError: actionRecorder.getInstallError(),
    segmentCount: segments.length,
    segments,
    events,
    before,
    after,
    diff: before && after ? diffSnapshots(before, after) : null,
    network: aggregateSegmentNetwork(segments)
  };
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
    aiRecordAction = false,
    aiGoal = '',
    aiInput = '',
    aiMode = 'hybrid',
    aiProvider = 'raw',
    aiTimeout = 180000,
    aiMaxSteps = 8,
    aiModel = null,
    aiMinConfidence = 0.7,
    aiPlan = null,
    browserControls = false,
    actionCount = null,
    networkSchema = false,
    waitForUser
  } = options;

  if (!url) throw new Error('Missing target URL');
  assertCompatibleDependencyVersions();
  const effectiveActionCount = Math.max(1, Number(actionCount || (browserControls ? 20 : 1)));

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
    const networkRecorder = attachNetworkRecorder(page, { captureSchema: networkSchema });
    const effectiveRecordAction = recordAction || aiRecordAction;
    const actionRecorder = effectiveRecordAction ? await installActionRecorder(page) : null;
    const controlPanel = browserControls ? await installBrowserControls(page) : null;
    await page.goto(url, { waitUntil: 'load', timeout }).catch(error => {
      throw new Error(`Navigation failed: ${error.message}`);
    });

    if (browserControls && controlPanel) {
      await controlPanel.setState({
        phase: 'prepare',
        actionIndex: 1,
        label: '',
        message: 'Prepare the page, then capture the baseline.'
      });
      await controlPanel.waitFor('prepare-ready');
    } else if ((interactive || (recordAction && !aiRecordAction)) && waitForUser) {
      await waitForUser(page, 'prepare');
    }

    const viewport = page.viewportSize();
    const baseOptions = captureOptions({
      headless,
      interactive,
      recordAction: recordAction || aiRecordAction,
      browserControls,
      actionCount: effectiveActionCount,
      timeout,
      userDataDir,
      browserPath,
      fixedWindow,
      networkSchema
    });
    const profile = await collectPageSnapshot(page, {
      initialUrl: sanitizeUrl(url),
      finalUrl: sanitizeUrl(page.url()),
      capturedAt: new Date().toISOString(),
      viewport,
      options: baseOptions
    });

    if ((recordAction || aiRecordAction) && (waitForUser || browserControls || aiRecordAction)) {
      const initialNetwork = networkRecorder.getSummary();
      const segments = [];

      if (aiRecordAction) {
        const beforeAction = await collectPageSnapshot(page, {
          initialUrl: sanitizeUrl(url),
          finalUrl: sanitizeUrl(page.url()),
          capturedAt: new Date().toISOString(),
          viewport: page.viewportSize(),
          options: baseOptions,
          phase: 'beforeAction:ai'
        });
        networkRecorder.reset();
        await actionRecorder.reset();
        const controllerLog = await runAiHybridAction(page, {
          goal: aiGoal,
          aiInput,
          adapterPlan: aiPlan,
          mode: aiMode,
          providerType: aiProvider,
          timeout: aiTimeout,
          maxSteps: aiMaxSteps,
          model: aiModel,
          minConfidence: aiMinConfidence,
          initialUrl: sanitizeUrl(url),
          captureOptions: baseOptions,
          controlPanel,
          waitForUser
        });
        await page.waitForLoadState('networkidle', { timeout: Math.min(timeout, 30000) }).catch(() => {});
        const afterAction = await collectPageSnapshot(page, {
          initialUrl: sanitizeUrl(url),
          finalUrl: sanitizeUrl(page.url()),
          capturedAt: new Date().toISOString(),
          viewport: page.viewportSize(),
          options: baseOptions,
          phase: 'afterAction:ai'
        });
        segments.push({
          id: 'action-001',
          index: 1,
          label: 'ai-action',
          mode: `ai-${aiMode}`,
          before: snapshotParts(beforeAction),
          after: snapshotParts(afterAction),
          diff: diffSnapshots(beforeAction, afterAction),
          events: await actionRecorder.getEvents(),
          network: networkRecorder.getSummary(),
          controller: controllerLog
        });
        if (controlPanel) await controlPanel.setState({ phase: 'done' });
      } else if (browserControls && controlPanel) {
        const maxActions = effectiveActionCount;
        for (let index = 1; index <= maxActions; index++) {
          await controlPanel.setState({ phase: 'ready', actionIndex: index, label: '' });
          const startSignal = await controlPanel.waitFor('start-action');
          const beforeAction = await collectPageSnapshot(page, {
            initialUrl: sanitizeUrl(url),
            finalUrl: sanitizeUrl(page.url()),
            capturedAt: new Date().toISOString(),
            viewport: page.viewportSize(),
            options: baseOptions,
            phase: `beforeAction:${index}`
          });
          networkRecorder.reset();
          await actionRecorder.reset();
          await controlPanel.setState({
            phase: 'recording',
            actionIndex: index,
            label: startSignal.label || `action-${index}`
          });
          const finishSignal = await controlPanel.waitFor(['finish-action', 'finish-capture']);
          await page.waitForLoadState('networkidle', { timeout: Math.min(timeout, 30000) }).catch(() => {});
          const afterAction = await collectPageSnapshot(page, {
            initialUrl: sanitizeUrl(url),
            finalUrl: sanitizeUrl(page.url()),
            capturedAt: new Date().toISOString(),
            viewport: page.viewportSize(),
            options: baseOptions,
            phase: `afterAction:${index}`
          });
          const id = `action-${String(index).padStart(3, '0')}`;
          const label = finishSignal.label || startSignal.label || id;
          segments.push({
            id,
            index,
            label,
            mode: 'browser-controls',
            before: snapshotParts(beforeAction),
            after: snapshotParts(afterAction),
            diff: diffSnapshots(beforeAction, afterAction),
            events: await actionRecorder.getEvents(),
            network: networkRecorder.getSummary()
          });
          if (finishSignal.type === 'finish-capture') break;
        }
        await controlPanel.setState({ phase: 'done' });
      } else {
        const count = effectiveActionCount;
        let beforeAction = profile;
        for (let index = 1; index <= count; index++) {
          networkRecorder.reset();
          await actionRecorder.reset();
          await waitForUser(page, 'record-action', { actionIndex: index, actionCount: count });
          await page.waitForLoadState('networkidle', { timeout: Math.min(timeout, 30000) }).catch(() => {});
          const afterAction = await collectPageSnapshot(page, {
            initialUrl: sanitizeUrl(url),
            finalUrl: sanitizeUrl(page.url()),
            capturedAt: new Date().toISOString(),
            viewport: page.viewportSize(),
            options: baseOptions,
            phase: `afterAction:${index}`
          });
          const id = `action-${String(index).padStart(3, '0')}`;
          segments.push({
            id,
            index,
            label: id,
            mode: count > 1 ? 'manual-multi' : 'manual',
            before: snapshotParts(beforeAction),
            after: snapshotParts(afterAction),
            diff: diffSnapshots(beforeAction, afterAction),
            events: await actionRecorder.getEvents(),
            network: networkRecorder.getSummary()
          });
          beforeAction = afterAction;
        }
      }

      profile.actionCapture = buildActionCapture({
        mode: aiRecordAction ? `ai-${aiMode}` : browserControls ? 'browser-controls' : effectiveActionCount > 1 ? 'manual-multi' : 'manual',
        actionRecorder,
        segments
      });
      profile.network = initialNetwork;
    } else {
      profile.network = networkRecorder.getSummary();
    }
    return profile;
  } finally {
    await context.close().catch(() => {});
  }
}
