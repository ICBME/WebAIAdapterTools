import fs from 'node:fs/promises';
import path from 'node:path';
import { renderHtmlReport } from './htmlReport.js';

const JSON_SPACE = 2;

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(value, null, JSON_SPACE), 'utf8');
}

function countElements(snapshot) {
  return {
    all: snapshot?.elements?.all?.length || 0,
    inputs: snapshot?.elements?.inputs?.length || 0,
    buttons: snapshot?.elements?.buttons?.length || 0,
    fileInputs: snapshot?.elements?.fileInputs?.length || 0,
    links: snapshot?.elements?.links?.length || 0,
    forms: snapshot?.elements?.forms?.length || 0,
    outputContainers: snapshot?.elements?.outputContainers?.length || 0
  };
}

function recommendationSummary(recommendations) {
  return {
    inputs: recommendations?.inputs?.slice(0, 3) || [],
    uploads: recommendations?.uploads?.slice(0, 3) || [],
    submits: recommendations?.submits?.slice(0, 3) || [],
    outputs: recommendations?.outputs?.slice(0, 3) || []
  };
}

function networkSummary(network) {
  return {
    summary: network?.summary || {},
    requestCount: network?.requests?.length || 0
  };
}

function actionSummary(actionCapture) {
  if (!actionCapture) return null;
  return {
    mode: actionCapture.mode,
    recorderInstalled: actionCapture.recorderInstalled,
    recorderInstallError: actionCapture.recorderInstallError || null,
    segmentCount: actionCapture.segmentCount || actionCapture.segments?.length || 0,
    eventCount: actionCapture.events?.length || 0,
    networkRequestCount: actionCapture.network?.requests?.length || 0,
    diffCounts: actionCapture.diff?.counts || {},
    beforeUrl: actionCapture.diff?.beforeUrl || null,
    afterUrl: actionCapture.diff?.afterUrl || null
  };
}

function buildIndex(profile, files) {
  const activeSnapshot = profile.actionCapture?.after || profile;
  return {
    schemaVersion: 'web-adapter-tools.capture-bundle.v1',
    sourceSchemaVersion: profile.schemaVersion,
    capture: profile.capture,
    page: activeSnapshot.page,
    counts: countElements(activeSnapshot),
    recommendations: recommendationSummary(activeSnapshot.recommendations),
    network: networkSummary(profile.network),
    action: actionSummary(profile.actionCapture),
    files
  };
}

export async function writeCaptureArtifacts(profile, outDir) {
  const files = {
    capture: 'capture.json',
    page: profile.actionCapture ? 'pages/after.json' : 'pages/current.json',
    elements: profile.actionCapture ? 'elements/after.json' : 'elements/current.json',
    recommendations: profile.actionCapture ? 'recommendations/after.json' : 'recommendations/current.json',
    network: 'network/initial.json',
    html: 'profile.html'
  };

  await fs.mkdir(outDir, { recursive: true });

  await writeJson(path.join(outDir, files.capture), {
    schemaVersion: profile.schemaVersion,
    capture: profile.capture
  });

  const currentSnapshot = profile.actionCapture?.after || {
    page: profile.page,
    elements: profile.elements,
    recommendations: profile.recommendations
  };

  await writeJson(path.join(outDir, files.page), currentSnapshot.page);
  await writeJson(path.join(outDir, files.elements), currentSnapshot.elements);
  await writeJson(path.join(outDir, files.recommendations), currentSnapshot.recommendations);
  await writeJson(path.join(outDir, files.network), profile.network || { summary: {}, requests: [] });

  if (profile.actionCapture) {
    files.beforePage = 'pages/before.json';
    files.beforeElements = 'elements/before.json';
    files.beforeRecommendations = 'recommendations/before.json';
    files.actionDiff = 'actions/diff.json';
    files.actionEvents = 'actions/events.json';
    files.actionNetwork = 'network/action.json';
    files.actionSegments = 'actions/segments.json';

    await writeJson(path.join(outDir, files.beforePage), profile.actionCapture.before?.page || {});
    await writeJson(path.join(outDir, files.beforeElements), profile.actionCapture.before?.elements || {});
    await writeJson(path.join(outDir, files.beforeRecommendations), profile.actionCapture.before?.recommendations || {});
    await writeJson(path.join(outDir, files.actionDiff), profile.actionCapture.diff || {});
    await writeJson(path.join(outDir, files.actionEvents), {
      mode: profile.actionCapture.mode,
      instructions: profile.actionCapture.instructions,
      recorderInstalled: profile.actionCapture.recorderInstalled,
      recorderInstallError: profile.actionCapture.recorderInstallError || null,
      segmentCount: profile.actionCapture.segmentCount || profile.actionCapture.segments?.length || 0,
      events: profile.actionCapture.events || []
    });
    await writeJson(path.join(outDir, files.actionNetwork), profile.actionCapture.network || { summary: {}, requests: [] });

    const segmentSummaries = [];
    for (const segment of profile.actionCapture.segments || []) {
      const segmentBase = `actions/segments/${segment.id}`;
      const segmentFiles = {
        events: `${segmentBase}/events.json`,
        diff: `${segmentBase}/diff.json`,
        network: `${segmentBase}/network.json`,
        beforePage: `${segmentBase}/before-page.json`,
        afterPage: `${segmentBase}/after-page.json`
      };
      await writeJson(path.join(outDir, segmentFiles.events), {
        id: segment.id,
        index: segment.index,
        label: segment.label,
        mode: segment.mode,
        events: segment.events || []
      });
      await writeJson(path.join(outDir, segmentFiles.diff), segment.diff || {});
      await writeJson(path.join(outDir, segmentFiles.network), segment.network || { summary: {}, requests: [] });
      await writeJson(path.join(outDir, segmentFiles.beforePage), segment.before?.page || {});
      await writeJson(path.join(outDir, segmentFiles.afterPage), segment.after?.page || {});
      segmentSummaries.push({
        id: segment.id,
        index: segment.index,
        label: segment.label,
        mode: segment.mode,
        eventCount: segment.events?.length || 0,
        networkRequestCount: segment.network?.requests?.length || 0,
        diffCounts: segment.diff?.counts || {},
        beforeUrl: segment.diff?.beforeUrl || segment.before?.page?.url || null,
        afterUrl: segment.diff?.afterUrl || segment.after?.page?.url || null,
        files: segmentFiles
      });
    }
    await writeJson(path.join(outDir, files.actionSegments), {
      mode: profile.actionCapture.mode,
      segmentCount: segmentSummaries.length,
      segments: segmentSummaries
    });
  }

  const index = buildIndex(profile, files);
  await writeJson(path.join(outDir, 'profile.json'), index);
  await fs.writeFile(path.join(outDir, files.html), renderHtmlReport(profile), 'utf8');

  return index;
}
