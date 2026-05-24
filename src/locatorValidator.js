import fs from 'node:fs/promises';
import path from 'node:path';
import { accessibleName, inferRole } from './locators.js';

const JSON_SPACE = 2;

function compact(value, max = 160) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function cleanSelectorString(value) {
  return String(value || '')
    .replace(/\\(["'\\])/g, '$1')
    .replace(/\\\\/g, '\\');
}

async function readJson(filePath, fallback = null) {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw error;
  }
}

function elementList(snapshot) {
  if (!snapshot) return [];
  if (Array.isArray(snapshot)) return snapshot;
  if (Array.isArray(snapshot.all)) return snapshot.all;
  if (Array.isArray(snapshot.elements?.all)) return snapshot.elements.all;
  return [];
}

function cssAttr(element, attr) {
  if (attr === 'id') return element.id || '';
  if (attr === 'class') return element.className || '';
  if (attr === 'aria-label') return element.ariaLabel || '';
  if (attr === 'placeholder') return element.placeholder || '';
  if (attr === 'name') return element.name || '';
  if (attr === 'type') return element.type || '';
  return element.attributes?.[attr] || '';
}

function classSet(element) {
  return new Set(String(element.className || '').split(/\s+/).filter(Boolean));
}

function matchesSimpleCss(element, selector) {
  const css = cleanSelectorString(selector).trim();
  if (!css) return false;
  if (element.cssPath && css === element.cssPath) return true;
  if (css === element.tag) return true;
  if (css === 'textarea') return element.tag === 'textarea';
  if (css.startsWith('#')) return element.id === css.slice(1);

  const idAttr = css.match(/^\[id=["'](.+)["']\]$/);
  if (idAttr) return element.id === idAttr[1];

  const attr = css.match(/^\[([a-zA-Z0-9_:-]+)=["'](.+)["']\]$/);
  if (attr) return cssAttr(element, attr[1]) === attr[2];

  const inputType = css.match(/^input\[type=["'](.+)["']\]$/);
  if (inputType) return element.tag === 'input' && String(element.type || '').toLowerCase() === inputType[1].toLowerCase();

  const tagClass = css.match(/^([a-zA-Z0-9_-]+)?((?:\.[a-zA-Z0-9_-]+)+)$/);
  if (tagClass) {
    const tag = tagClass[1] || '';
    if (tag && element.tag !== tag) return false;
    const classes = tagClass[2].split('.').filter(Boolean);
    const set = classSet(element);
    return classes.every(cls => set.has(cls));
  }

  return false;
}

function readJsStringAt(text, start) {
  const quote = text[start];
  if (!['"', "'"].includes(quote)) return null;
  let value = '';
  for (let index = start + 1; index < text.length; index++) {
    const char = text[index];
    if (char === '\\') {
      value += text[index + 1] || '';
      index += 1;
      continue;
    }
    if (char === quote) return { value, end: index + 1 };
    value += char;
  }
  return null;
}

function parseQuotedArgument(expression, fnName) {
  const text = String(expression || '');
  const prefix = `page.${fnName}(`;
  const start = text.indexOf(prefix);
  if (start < 0) return '';
  const offset = start + prefix.length;
  const parsed = readJsStringAt(text, offset);
  return parsed ? parsed.value : '';
}

function parseRoleLocator(expression) {
  const value = String(expression || '');
  const role = parseQuotedArgument(value, 'getByRole');
  if (!role) return null;
  const nameString = value.match(/name:\s*(["'])(.*?)\1/);
  const nameRegex = value.match(/name:\s*\/(.+)\/([a-z]*)/);
  return {
    role,
    name: nameString ? cleanSelectorString(nameString[2]) : '',
    nameRegex: nameRegex ? new RegExp(nameRegex[1], nameRegex[2]) : null
  };
}

function parsePageLocator(expression) {
  return parseQuotedArgument(expression, 'locator');
}

function matchLocator(elements, expression) {
  const value = String(expression || '').trim();
  const role = parseRoleLocator(value);
  if (role) {
    return elements.filter(element => {
      if (inferRole(element) !== role.role) return false;
      if (!role.name && !role.nameRegex) return true;
      const name = accessibleName(element);
      return role.nameRegex ? role.nameRegex.test(name) : name === role.name;
    });
  }

  const locatorCss = parsePageLocator(value);
  if (locatorCss) return elements.filter(element => matchesSimpleCss(element, locatorCss));

  const text = parseQuotedArgument(value, 'getByText');
  if (text) return elements.filter(element => compact(element.text).includes(text));

  const label = parseQuotedArgument(value, 'getByLabel');
  if (label) return elements.filter(element => compact(element.labelText || element.ariaLabel).includes(label));

  const placeholder = parseQuotedArgument(value, 'getByPlaceholder');
  if (placeholder) return elements.filter(element => element.placeholder === placeholder);

  const title = parseQuotedArgument(value, 'getByTitle');
  if (title) return elements.filter(element => element.attributes?.title === title);

  const testId = parseQuotedArgument(value, 'getByTestId');
  if (testId) {
    return elements.filter(element => ['data-testid', 'data-test', 'data-cy'].some(attr => element.attributes?.[attr] === testId));
  }

  return [];
}

function expectedCategories(kind) {
  if (kind === 'input') return ['input'];
  if (kind === 'upload') return ['fileInput', 'button', 'link'];
  if (kind === 'submit') return ['button', 'input'];
  if (kind === 'output') return ['output'];
  return [];
}

function elementSignature(element) {
  return [
    element.id,
    element.cssPath,
    element.attributes?.['data-testid'],
    element.attributes?.['data-test'],
    element.attributes?.['data-cy'],
    element.ariaLabel,
    element.placeholder,
    element.tag,
    inferRole(element),
    compact(element.text, 80)
  ].filter(Boolean).join('|');
}

function snapshotScore(matches, kind) {
  if (!matches.length) {
    return { score: 0, visibleRatio: 0, categoryRatio: 0, unique: false };
  }
  const visibleRatio = matches.filter(element => element.visible !== false).length / matches.length;
  const categories = expectedCategories(kind);
  const categoryRatio = categories.length
    ? matches.filter(element => categories.some(category => element.categories?.includes(category))).length / matches.length
    : 1;
  const uniqueScore = matches.length === 1 ? 35 : Math.max(5, 24 - Math.min(18, matches.length * 3));
  const score = uniqueScore + visibleRatio * 15 + categoryRatio * 20;
  return { score, visibleRatio, categoryRatio, unique: matches.length === 1 };
}

function validateOneLocator(locator, kind, snapshots) {
  const expression = locator?.value || '';
  const snapshotResults = snapshots.map(snapshot => {
    const matches = matchLocator(snapshot.elements, expression);
    const score = snapshotScore(matches, kind);
    return {
      name: snapshot.name,
      matchCount: matches.length,
      visibleCount: matches.filter(element => element.visible !== false).length,
      categoryMatchCount: matches.filter(element => expectedCategories(kind).some(category => element.categories?.includes(category))).length,
      unique: score.unique,
      signatures: matches.slice(0, 5).map(elementSignature),
      score: Math.round(score.score)
    };
  });

  const active = snapshotResults.filter(result => result.matchCount > 0);
  const coverage = snapshots.length ? active.length / snapshots.length : 0;
  const averageSnapshotScore = snapshots.length
    ? snapshotResults.reduce((sum, result) => sum + result.score, 0) / snapshots.length
    : 0;
  const uniqueCoverage = snapshots.length
    ? snapshotResults.filter(result => result.unique).length / snapshots.length
    : 0;
  const firstSignatures = active.map(result => result.signatures[0]).filter(Boolean);
  const consistent = firstSignatures.length > 1 && new Set(firstSignatures).size === 1;
  const confidence = Number(locator?.confidence || 0);

  const stableScore = Math.max(0, Math.min(100, Math.round(
    averageSnapshotScore +
    coverage * 18 +
    uniqueCoverage * 12 +
    (consistent ? 10 : firstSignatures.length ? 4 : 0) +
    confidence * 10
  )));

  const warnings = [];
  if (!coverage) warnings.push('Locator did not match any captured snapshot.');
  else if (coverage < 1) warnings.push('Locator does not match every available snapshot.');
  if (uniqueCoverage < 1) warnings.push('Locator is not unique in every available snapshot.');
  if (active.some(result => result.visibleCount === 0)) warnings.push('Locator matched only invisible elements in at least one snapshot.');
  if (expectedCategories(kind).length && active.some(result => result.categoryMatchCount === 0)) warnings.push(`Locator matches elements outside expected ${kind} category.`);
  if (firstSignatures.length > 1 && !consistent) warnings.push('Locator appears to match different element signatures across snapshots.');

  return {
    expression,
    kind,
    stableScore,
    status: stableScore >= 80 ? 'stable' : stableScore >= 50 ? 'warning' : 'unstable',
    coverage,
    uniqueCoverage,
    consistent,
    snapshots: snapshotResults,
    warnings
  };
}

export function collectLocatorRefs(plan) {
  const refs = [];
  for (const [index, input] of (plan.operation?.inputs || []).entries()) {
    if (input.locator?.value) {
      refs.push({ path: `operation.inputs[${index}].locator`, kind: input.type === 'file' ? 'upload' : 'input', locator: input.locator });
    }
  }
  if (plan.operation?.submit?.locator?.value) {
    refs.push({ path: 'operation.submit.locator', kind: 'submit', locator: plan.operation.submit.locator });
  }
  for (const [index, output] of (plan.operation?.outputs || []).entries()) {
    if (output.locator?.value) refs.push({ path: `operation.outputs[${index}].locator`, kind: 'output', locator: output.locator });
  }
  for (const [index, step] of (plan.operation?.setupSteps || []).entries()) {
    if (step.locator?.value) refs.push({ path: `operation.setupSteps[${index}].locator`, kind: step.type === 'upload' ? 'upload' : 'input', locator: step.locator });
  }
  for (const [index, signal] of (plan.operation?.waitSignals || []).entries()) {
    if (signal.locator?.value) refs.push({ path: `operation.waitSignals[${index}].locator`, kind: 'output', locator: signal.locator });
  }
  for (const [index, extractor] of (plan.operation?.extractors || []).entries()) {
    if (extractor.locator?.value) refs.push({ path: `operation.extractors[${index}].locator`, kind: extractor.type === 'image' ? 'output' : 'output', locator: extractor.locator });
  }

  const seen = new Set();
  return refs.filter(ref => {
    const key = `${ref.path}|${ref.locator.value}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function setPath(root, pathExpression, value) {
  const parts = String(pathExpression).replace(/\[(\d+)\]/g, '.$1').split('.');
  let current = root;
  for (const part of parts) {
    if (!part) continue;
    current = current?.[part];
  }
  if (current && typeof current === 'object') current.stability = value;
}

export async function loadLocatorValidationInputs(captureDir, options = {}) {
  const root = path.resolve(captureDir);
  const profile = await readJson(path.join(root, 'profile.json'));
  if (!profile) throw new Error(`Missing profile.json in ${root}`);
  const interfacePath = options.interfacePath ? path.resolve(options.interfacePath) : path.join(root, 'interface.json');
  const plan = options.plan || await readJson(interfacePath);
  if (!plan) throw new Error(`Missing interface.json in ${root}`);

  const files = profile.files || {};
  const snapshots = [];
  async function addSnapshot(name, relPath) {
    if (!relPath) return;
    const data = await readJson(path.join(root, relPath), null);
    const elements = elementList(data);
    if (elements.length) snapshots.push({ name, elements });
  }

  await addSnapshot('before', files.beforeElements);
  await addSnapshot(files.beforeElements ? 'after' : 'current', files.elements);

  if (!snapshots.length && profile.counts) {
    throw new Error('Capture profile references no element snapshot files.');
  }

  return { plan, profile, snapshots, interfacePath, root };
}

export function validateInterfaceLocators(plan, snapshots, options = {}) {
  const refs = collectLocatorRefs(plan);
  const results = refs.map(ref => ({
    path: ref.path,
    ...validateOneLocator(ref.locator, ref.kind, snapshots)
  }));
  const scores = results.map(result => result.stableScore);
  const minScore = scores.length ? Math.min(...scores) : 0;
  const averageScore = scores.length ? Math.round(scores.reduce((sum, score) => sum + score, 0) / scores.length) : 0;
  const threshold = Number(options.minScore || 70);
  const unstable = results.filter(result => result.stableScore < threshold);

  return {
    schemaVersion: 'web-adapter-tools.locator-validation.v1',
    generatedAt: new Date().toISOString(),
    threshold,
    snapshotCount: snapshots.length,
    locatorCount: results.length,
    minScore,
    averageScore,
    ok: unstable.length === 0,
    unstableCount: unstable.length,
    results
  };
}

export function applyLocatorValidation(plan, validation) {
  const cloned = JSON.parse(JSON.stringify(plan));
  cloned.locatorValidation = {
    schemaVersion: validation.schemaVersion,
    generatedAt: validation.generatedAt,
    threshold: validation.threshold,
    locatorCount: validation.locatorCount,
    minScore: validation.minScore,
    averageScore: validation.averageScore,
    ok: validation.ok,
    unstableCount: validation.unstableCount,
    dynamic: validation.dynamic || null
  };
  for (const result of validation.results || []) {
    setPath(cloned, result.path, {
      stableScore: result.stableScore,
      status: result.status,
      coverage: result.coverage,
      uniqueCoverage: result.uniqueCoverage,
      consistent: result.consistent,
      warnings: result.warnings,
      dynamic: result.dynamic || null
    });
  }
  return cloned;
}

export function renderLocatorValidationMarkdown(validation) {
  const lines = [];
  lines.push('# Locator Validation');
  lines.push('');
  lines.push(`Status: ${validation.ok ? 'passed' : 'needs review'}`);
  lines.push(`Locators: ${validation.locatorCount}`);
  lines.push(`Snapshots: ${validation.snapshotCount}`);
  lines.push(`Average score: ${validation.averageScore}/100`);
  lines.push(`Minimum score: ${validation.minScore}/100`);
  if (validation.dynamic?.enabled) {
    lines.push('');
    lines.push('## Dynamic Validation');
    lines.push(`Dynamic status: ${validation.dynamic.ok ? 'passed' : 'needs review'}`);
    lines.push(`Dynamic URL: ${validation.dynamic.url || '(unknown)'}`);
    lines.push(`Dynamic average score: ${validation.dynamic.averageScore}/100`);
    lines.push(`Dynamic minimum score: ${validation.dynamic.minScore}/100`);
  }
  lines.push('');
  lines.push('## Results');
  for (const result of validation.results || []) {
    lines.push(`- ${result.status.toUpperCase()} ${result.stableScore}/100 \`${result.path}\``);
    lines.push(`  - ${result.expression}`);
    const snapshotText = result.snapshots.map(snapshot => `${snapshot.name}: ${snapshot.matchCount}`).join(', ');
    lines.push(`  - matches: ${snapshotText}`);
    for (const warning of result.warnings || []) lines.push(`  - warning: ${warning}`);
    if (result.dynamic) {
      lines.push(`  - dynamic: ${result.dynamic.status} ${result.dynamic.score}/100 count=${result.dynamic.checks?.count ?? 0}`);
      if (result.dynamic.error) lines.push(`  - dynamic error: ${result.dynamic.error}`);
    }
  }
  lines.push('');
  return lines.join('\n');
}

export async function writeLocatorValidationArtifacts(validation, outDir) {
  await fs.mkdir(outDir, { recursive: true });
  const jsonPath = path.join(outDir, 'locator-validation.json');
  const mdPath = path.join(outDir, 'locator-validation.md');
  await fs.writeFile(jsonPath, JSON.stringify(validation, null, JSON_SPACE), 'utf8');
  await fs.writeFile(mdPath, renderLocatorValidationMarkdown(validation), 'utf8');
  return { jsonPath, mdPath };
}
