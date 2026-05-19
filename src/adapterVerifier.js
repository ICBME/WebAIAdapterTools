import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DEFAULT_WINDOW_SIZE } from './size.js';
import { assertCompatibleDependencyVersions } from './versionGuard.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');
const JSON_SPACE = 2;

function assertAdapterId(id) {
  if (!/^[a-z][a-z0-9_]*$/.test(String(id || ''))) {
    throw new Error(`Invalid adapter id: ${id}`);
  }
  return id;
}

function defaultVerifyUserDataDir(adapterId) {
  return path.join(PROJECT_ROOT, '.profiles', 'verify', adapterId);
}

async function loadCamoufox() {
  try {
    return await import('camoufox-js');
  } catch (error) {
    throw new Error(`camoufox-js is not installed. Run "pnpm install" in WebAdapterTools. Original error: ${error.message}`);
  }
}

async function pathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function slugName(value, fallback = 'step') {
  const cleaned = String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return cleaned || fallback;
}

function relativeTo(baseDir, filePath) {
  return path.relative(baseDir, filePath).replaceAll(path.sep, '/');
}

async function safePageValue(page, getter, fallback = null) {
  try {
    return await getter(page);
  } catch {
    return fallback;
  }
}

async function updateOverlay(page, text) {
  await page.evaluate(label => {
    let el = document.getElementById('__web_adapter_tools_verify_overlay');
    if (!el) {
      el = document.createElement('div');
      el.id = '__web_adapter_tools_verify_overlay';
      document.documentElement.appendChild(el);
    }
    el.textContent = label;
    Object.assign(el.style, {
      position: 'fixed',
      top: '12px',
      left: '12px',
      zIndex: '2147483647',
      maxWidth: '520px',
      padding: '8px 10px',
      border: '1px solid rgba(255,255,255,0.35)',
      borderRadius: '6px',
      background: 'rgba(0, 0, 0, 0.78)',
      color: '#fff',
      font: '12px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
      boxShadow: '0 6px 22px rgba(0,0,0,0.28)',
      pointerEvents: 'none',
      whiteSpace: 'pre-wrap'
    });
  }, text).catch(() => {});
}

export function createVisualRecorder(page, options = {}) {
  const outDir = options.outDir ? path.resolve(options.outDir) : null;
  const screenshotsDir = outDir ? path.join(outDir, 'screenshots') : null;
  const slowMo = Math.max(0, Number(options.slowMo || 0));
  const steps = [];
  let counter = 0;

  return {
    steps,
    async init() {
      if (screenshotsDir) await fs.mkdir(screenshotsDir, { recursive: true });
    },
    async step(event = {}) {
      counter += 1;
      const name = slugName(event.name || event.label, `step-${counter}`);
      const label = event.label || event.name || name;
      const timestamp = new Date().toISOString();
      const url = event.url || await safePageValue(page, p => p.url(), '');
      const title = await safePageValue(page, p => p.title(), '');
      const record = {
        index: counter,
        name,
        label,
        timestamp,
        url,
        title,
        ...event
      };

      if (options.visual || outDir) {
        await updateOverlay(page, `${counter}. ${label}\n${url || ''}`);
      }

      if (screenshotsDir) {
        const screenshotPath = path.join(screenshotsDir, `${String(counter).padStart(3, '0')}-${name}.png`);
        try {
          await page.screenshot({ path: screenshotPath, fullPage: false });
          record.screenshot = relativeTo(outDir, screenshotPath);
        } catch (error) {
          record.screenshotError = error.message;
        }
      }

      steps.push(record);
      if (slowMo) await sleep(slowMo);
      return record;
    },
    async writeArtifacts(summary = {}) {
      if (!outDir) return {};
      await fs.mkdir(outDir, { recursive: true });
      const finalHtmlPath = path.join(outDir, summary.ok ? 'final-page.html' : 'error-page.html');
      const verifyPath = path.join(outDir, 'verify.json');
      const timelinePath = path.join(outDir, 'timeline.md');
      const html = await safePageValue(page, p => p.content(), '');
      if (html) await fs.writeFile(finalHtmlPath, html, 'utf8');

      const payload = {
        ...summary,
        visual: {
          stepCount: steps.length,
          screenshotsDir: screenshotsDir ? relativeTo(outDir, screenshotsDir) : null,
          finalHtml: html ? relativeTo(outDir, finalHtmlPath) : null
        },
        steps
      };
      await fs.writeFile(verifyPath, JSON.stringify(payload, null, JSON_SPACE), 'utf8');

      const lines = [];
      lines.push(`# Adapter Verification: ${summary.adapterId || ''}`);
      lines.push('');
      lines.push(`- Status: ${summary.ok ? 'passed' : 'failed'}`);
      lines.push(`- Model: ${summary.modelId || ''}`);
      lines.push(`- Elapsed: ${summary.elapsedMs || 0}ms`);
      if (summary.result?.error) lines.push(`- Error: ${summary.result.error}`);
      lines.push('');
      lines.push('## Timeline');
      for (const step of steps) {
        const shot = step.screenshot ? ` (${step.screenshot})` : '';
        lines.push(`- ${String(step.index).padStart(3, '0')} ${step.label}${shot}`);
      }
      lines.push('');
      await fs.writeFile(timelinePath, lines.join('\n'), 'utf8');

      return {
        outDir,
        verifyPath,
        timelinePath,
        finalHtmlPath: html ? finalHtmlPath : null
      };
    }
  };
}

export async function loadAdapterManifest(targetRoot, adapterId) {
  const safeId = assertAdapterId(adapterId);
  const adapterPath = path.join(path.resolve(targetRoot), 'src', 'backend', 'adapter', `${safeId}.js`);
  if (!await pathExists(adapterPath)) {
    throw new Error(`Adapter file not found: ${adapterPath}`);
  }

  const moduleUrl = `${pathToFileURL(adapterPath).href}?verify=${Date.now()}`;
  const module = await import(moduleUrl);
  const manifest = module.manifest;
  if (!manifest || typeof manifest !== 'object') {
    throw new Error(`Adapter ${safeId} does not export manifest`);
  }
  if (manifest.id !== safeId) {
    throw new Error(`Adapter manifest id mismatch: expected ${safeId}, got ${manifest.id || '(empty)'}`);
  }
  if (typeof manifest.generate !== 'function') {
    throw new Error(`Adapter ${safeId} manifest.generate is missing`);
  }
  if (!Array.isArray(manifest.models) || manifest.models.length === 0) {
    throw new Error(`Adapter ${safeId} manifest.models is empty`);
  }

  return { manifest, adapterPath };
}

export async function verifyAdapter(options = {}) {
  const adapterId = assertAdapterId(options.adapterId);
  const targetRoot = path.resolve(options.target || '../WebAI2API');
  const prompt = String(options.prompt || '').trim();
  if (!prompt) throw new Error('--prompt is required');

  assertCompatibleDependencyVersions();
  const { manifest, adapterPath } = await loadAdapterManifest(targetRoot, adapterId);
  const modelId = options.model || manifest.models[0]?.id;
  if (!modelId) throw new Error(`Adapter ${adapterId} has no model id to verify`);

  const timeout = Number(options.timeout || 120000);
  if (!Number.isFinite(timeout) || timeout <= 0) {
    throw new Error('--timeout must be a positive number');
  }

  const windowSize = options.windowSize || DEFAULT_WINDOW_SIZE;
  const fixedWindow = [
    Number(windowSize.width || DEFAULT_WINDOW_SIZE.width),
    Number(windowSize.height || DEFAULT_WINDOW_SIZE.height)
  ];
  const userDataDir = path.resolve(options.userDataDir || defaultVerifyUserDataDir(adapterId));
  const { Camoufox } = await loadCamoufox();
  const visualOut = options.visualOut ? path.resolve(options.visualOut) : null;
  if (visualOut) await fs.mkdir(visualOut, { recursive: true });
  const headless = options.visual ? false : Boolean(options.headless);
  const browser = await Camoufox({
    headless,
    user_data_dir: userDataDir,
    executable_path: options.browserPath ? path.resolve(options.browserPath) : undefined,
    window: fixedWindow,
    args: [`--width=${fixedWindow[0]}`, `--height=${fixedWindow[1]}`],
    i_know_what_im_doing: true
  });

  const startedAt = Date.now();
  let tracePath = null;
  let summary = null;
  let visualRecorder = null;
  try {
    const page = browser.pages()[0] || await browser.newPage();
    await page.setViewportSize({ width: fixedWindow[0], height: fixedWindow[1] }).catch(() => {});
    if (visualOut && browser.tracing?.start) {
      tracePath = path.join(visualOut, 'trace.zip');
      await browser.tracing.start({ screenshots: true, snapshots: true, sources: true }).catch(() => {
        tracePath = null;
      });
    }

    visualRecorder = createVisualRecorder(page, {
      outDir: visualOut,
      visual: options.visual,
      slowMo: options.slowMo
    });
    await visualRecorder.init();
    await visualRecorder.step({
      name: 'verifier-start',
      label: 'Verifier started',
      adapterId,
      modelId
    });

    const context = {
      page,
      config: {
        backend: {
          pool: {
            waitTimeout: timeout
          }
        },
        browser: {
          headless
        }
      }
    };

    let result;
    try {
      result = await manifest.generate(context, prompt, options.paths || [], modelId, {
        verifier: 'WebAdapterTools',
        adapter: adapterId,
        model: modelId,
        visualObserver: visualRecorder
      });
    } catch (error) {
      result = { error: error.message };
      await visualRecorder.step({
        name: 'adapter-threw',
        label: 'Adapter threw an exception',
        error: error.message
      });
    }
    const elapsedMs = Date.now() - startedAt;
    await visualRecorder.step({
      name: result?.error ? 'verifier-failed' : 'verifier-passed',
      label: result?.error ? 'Verification failed' : 'Verification passed',
      textLength: result?.text ? String(result.text).length : 0,
      imageLength: result?.image ? String(result.image).length : 0,
      error: result?.error || null
    });

    summary = {
      ok: Boolean(result && !result.error),
      adapterId,
      adapterPath,
      modelId,
      elapsedMs,
      result,
      textLength: result?.text ? String(result.text).length : 0,
      imageLength: result?.image ? String(result.image).length : 0,
      visualOut,
      tracePath
    };
    const artifactPaths = await visualRecorder.writeArtifacts(summary);
    summary.artifacts = artifactPaths;
    return summary;
  } finally {
    if (tracePath && browser.tracing?.stop) {
      await browser.tracing.stop({ path: tracePath }).catch(() => {
        tracePath = null;
      });
    }
    if (!(options.pauseOnError && summary && !summary.ok)) {
      await browser.close().catch(() => {});
    }
  }
}
