import { getActionSpec, isKnownAiAction } from './actions.js';

const RISK_PATTERN = /\b(log\s*in|sign\s*in|sign\s*up|authorize|oauth|captcha|verify|verification|password|passcode|2fa|mfa|account|payment|purchase|delete|remove)\b|登录|登陆|注册|授权|验证码|验证|密码|支付|购买|删除/i;

function compact(value, max = 200) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function elementText(element) {
  return [
    element?.text,
    element?.placeholder,
    element?.ariaLabel,
    element?.labelText,
    element?.idRef,
    element?.cssPath
  ].filter(Boolean).join(' ');
}

function lower(value) {
  return String(value || '').toLowerCase();
}

function matchesAllowed(element, spec) {
  const tag = lower(element.tag);
  const role = lower(element.role);
  const type = lower(element.type);
  const categories = (element.categories || []).map(lower);
  const hasRestrictions = Boolean(spec.allowedTags?.length || spec.allowedRoles?.length || spec.allowedTypes?.length || spec.allowedCategories?.length);
  if (!hasRestrictions) return true;
  if (spec.allowedTags?.includes(tag)) return true;
  if (spec.allowedRoles?.includes(role)) return true;
  if (spec.allowedTypes?.includes(type)) return true;
  if (spec.allowedCategories?.some(category => categories.includes(category))) return true;
  return false;
}

function assertSafeElement(element, action) {
  if (!element) throw new Error('AI decision targetRef was not found in the current observation');
  if (!element.cssPath) throw new Error(`Target ${element.idRef} does not have a cssPath`);
  const spec = getActionSpec(action) || {};
  if (element.risk || RISK_PATTERN.test(elementText(element))) {
    throw new Error(`Target ${element.idRef} looks sensitive or risky`);
  }
  if (element.disabled) throw new Error(`Target ${element.idRef} is disabled`);
  if (!element.visible && !spec.allowHiddenTarget) throw new Error(`Target ${element.idRef} is not visible`);
  if (spec.requiresEditable && element.readOnly) throw new Error(`Target ${element.idRef} is read-only`);
  if (!matchesAllowed(element, spec)) throw new Error(`Target ${element.idRef} is not valid for ${action}`);
}

function targetLocator(page, observation, targetRef, action) {
  const element = observation.targetMap.get(targetRef);
  assertSafeElement(element, action);
  return {
    element,
    locator: page.locator(element.cssPath).first()
  };
}

function isPointerInterceptError(error) {
  return /intercepts pointer events|receives pointer events|subtree intercepts pointer events|element is not stable|element is outside of the viewport/i.test(error?.message || '');
}

async function settle(page, ms = 250) {
  if (typeof page.waitForTimeout === 'function') {
    await page.waitForTimeout(ms).catch(() => {});
    return;
  }
  await new Promise(resolve => setTimeout(resolve, ms));
}

async function dismissTransientOverlays(page) {
  await page.keyboard?.press?.('Escape').catch(() => {});
  await page.mouse?.move?.(1, 1).catch(() => {});
  await settle(page, 250);
}

async function safeAiClick(page, locator, timeout) {
  try {
    await locator.click({ timeout });
    return { retries: 0 };
  } catch (error) {
    if (!isPointerInterceptError(error)) throw error;
    await dismissTransientOverlays(page);
  }

  try {
    await locator.click({ timeout });
    return { retries: 1 };
  } catch (error) {
    if (!isPointerInterceptError(error)) throw error;
    await dismissTransientOverlays(page);
    await locator.click({ timeout, force: true });
    return { retries: 2, forced: true };
  }
}

function params(decision) {
  return decision.params && typeof decision.params === 'object' ? decision.params : {};
}

function inputValue(observation, decision) {
  const p = params(decision);
  const valueFrom = p.valueFrom ?? decision.valueFrom;
  return valueFrom === 'aiInput' ? observation.aiInput : p.value ?? decision.value ?? '';
}

function keyValue(decision) {
  return compact(params(decision).key || decision.key || 'Enter', 40);
}

function timeoutValue(decision, fallback) {
  const value = Number(params(decision).timeout || params(decision).ms || fallback);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function uploadPaths(decision, options) {
  const p = params(decision);
  const raw = p.paths || decision.paths || p.path || decision.path || [];
  const requested = Array.isArray(raw) ? raw : [raw].filter(Boolean);
  const allowed = new Set((options.uploadPaths || options.allowedUploadPaths || []).map(String));
  if (!requested.length) throw new Error('AI upload requires params.path or params.paths');
  if (!allowed.size) throw new Error('AI upload requires allowed upload paths from caller options');
  for (const item of requested) {
    if (!allowed.has(String(item))) throw new Error(`AI upload path is not in the allowed list: ${compact(item, 160)}`);
  }
  return requested.map(String);
}

async function waitForText(locator, text, timeout) {
  const expected = String(text || '');
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const current = await locator.textContent({ timeout: Math.min(500, Math.max(1, deadline - Date.now())) }).catch(() => '');
    if (String(current || '').includes(expected)) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for text: ${compact(expected, 120)}`);
}

async function executeTargetWait(locator, decision, timeout) {
  const p = params(decision);
  const state = compact(p.state || 'visible', 40);
  if (!['attached', 'detached', 'visible', 'hidden'].includes(state)) {
    throw new Error(`Unsupported waitFor state: ${state}`);
  }
  await locator.waitFor({ state, timeout });
  if (p.text) await waitForText(locator, p.text, timeout);
}

export function shouldFallbackDecision(decision, options = {}) {
  const minConfidence = Number(options.minConfidence ?? 0.7);
  if (!decision || typeof decision !== 'object') return 'AI decision is empty';
  if (decision.mode === 'ask_user') return decision.reason || 'AI requested human assistance';
  if (decision.mode === 'finish') return '';
  if (decision.mode !== 'execute') return `Unsupported AI decision mode: ${decision.mode}`;
  const spec = getActionSpec(decision.action);
  if (!spec || !isKnownAiAction(decision.action)) return `Unsupported AI action: ${decision.action}`;
  if (Number(decision.confidence || 0) < minConfidence) {
    return `AI confidence ${decision.confidence || 0} is below ${minConfidence}`;
  }
  if (spec.requiresTarget && !decision.targetRef) {
    return `AI action ${decision.action} requires targetRef`;
  }
  return '';
}

export async function executeAiDecision(page, observation, decision, options = {}) {
  const timeout = Number(options.timeout || 10000);
  if (decision.mode === 'finish') {
    return { ok: true, finished: true };
  }

  const fallbackReason = shouldFallbackDecision(decision, options);
  if (fallbackReason) {
    return { ok: false, fallbackReason };
  }

  if (decision.action === 'fill') {
    const { locator, element } = targetLocator(page, observation, decision.targetRef, 'fill');
    await locator.waitFor({ state: 'visible', timeout });
    const value = inputValue(observation, decision);
    await locator.fill('');
    await locator.fill(String(value || ''));
    return { ok: true, action: 'fill', targetRef: element.idRef, valueLength: String(value || '').length };
  }

  if (decision.action === 'type') {
    const { locator, element } = targetLocator(page, observation, decision.targetRef, 'type');
    await locator.waitFor({ state: 'visible', timeout });
    const value = inputValue(observation, decision);
    await locator.type(String(value || ''), { delay: Number(params(decision).delay || 0) || undefined });
    return { ok: true, action: 'type', targetRef: element.idRef, valueLength: String(value || '').length };
  }

  if (decision.action === 'clear') {
    const { locator, element } = targetLocator(page, observation, decision.targetRef, 'clear');
    await locator.waitFor({ state: 'visible', timeout });
    await locator.fill('');
    return { ok: true, action: 'clear', targetRef: element.idRef };
  }

  if (decision.action === 'click') {
    const { locator, element } = targetLocator(page, observation, decision.targetRef, 'click');
    await locator.waitFor({ state: 'visible', timeout });
    try {
      const clickResult = await safeAiClick(page, locator, timeout);
      return { ok: true, action: 'click', targetRef: element.idRef, ...clickResult };
    } catch (error) {
      return { ok: false, fallbackReason: `AI click failed for ${element.idRef}: ${compact(error.message, 300)}` };
    }
  }

  if (decision.action === 'press') {
    const key = keyValue(decision);
    if (decision.targetRef) {
      const { locator, element } = targetLocator(page, observation, decision.targetRef, 'press');
      await locator.waitFor({ state: 'visible', timeout });
      await locator.press(key);
      return { ok: true, action: 'press', targetRef: element.idRef, key };
    }
    await page.keyboard.press(key);
    return { ok: true, action: 'press', key };
  }

  if (decision.action === 'select') {
    const { locator, element } = targetLocator(page, observation, decision.targetRef, 'select');
    await locator.waitFor({ state: 'visible', timeout });
    const p = params(decision);
    const option = p.label !== undefined ? { label: String(p.label) }
      : p.index !== undefined ? { index: Number(p.index) }
        : { value: String(p.value ?? '') };
    await locator.selectOption(option, { timeout });
    return { ok: true, action: 'select', targetRef: element.idRef, option };
  }

  if (decision.action === 'check' || decision.action === 'uncheck') {
    const { locator, element } = targetLocator(page, observation, decision.targetRef, decision.action);
    await locator.waitFor({ state: 'visible', timeout });
    const nativeToggle = lower(element.tag) === 'input' && ['checkbox', 'radio'].includes(lower(element.type));
    if (nativeToggle && decision.action === 'check') {
      await locator.check({ timeout });
    } else if (nativeToggle) {
      await locator.uncheck({ timeout });
    } else {
      const current = element.checked ?? (lower(element.ariaChecked) === 'true' ? true : lower(element.ariaChecked) === 'false' ? false : null);
      const desired = decision.action === 'check';
      if (current !== desired) await locator.click({ timeout });
    }
    return { ok: true, action: decision.action, targetRef: element.idRef };
  }

  if (decision.action === 'hover') {
    const { locator, element } = targetLocator(page, observation, decision.targetRef, 'hover');
    await locator.waitFor({ state: 'visible', timeout });
    await locator.hover({ timeout });
    return { ok: true, action: 'hover', targetRef: element.idRef };
  }

  if (decision.action === 'scroll') {
    const p = params(decision);
    if (decision.targetRef) {
      const { locator, element } = targetLocator(page, observation, decision.targetRef, 'scroll');
      await locator.scrollIntoViewIfNeeded({ timeout });
      return { ok: true, action: 'scroll', targetRef: element.idRef };
    }
    const amount = Number(p.amount || 600);
    const direction = compact(p.direction || 'down', 20).toLowerCase();
    const delta = direction === 'up' || direction === 'left' ? -Math.abs(amount) : Math.abs(amount);
    if (direction === 'left' || direction === 'right') {
      await page.mouse?.wheel?.(delta, 0);
    } else {
      await page.mouse?.wheel?.(0, delta);
    }
    return { ok: true, action: 'scroll', direction, amount: Math.abs(amount) };
  }

  if (decision.action === 'wait') {
    if (decision.targetRef) {
      const { locator, element } = targetLocator(page, observation, decision.targetRef, 'wait');
      await locator.waitFor({ state: 'visible', timeout });
      return { ok: true, action: 'wait', targetRef: element.idRef };
    }
    await page.waitForLoadState('networkidle', { timeout }).catch(() => {});
    return { ok: true, action: 'wait' };
  }

  if (decision.action === 'waitFor') {
    const p = params(decision);
    const waitTimeout = timeoutValue(decision, timeout);
    if (decision.targetRef) {
      const { locator, element } = targetLocator(page, observation, decision.targetRef, 'waitFor');
      await executeTargetWait(locator, decision, waitTimeout);
      return { ok: true, action: 'waitFor', targetRef: element.idRef, state: p.state || 'visible', text: p.text || null };
    }
    if (p.loadState) {
      await page.waitForLoadState(p.loadState, { timeout: waitTimeout }).catch(() => {});
      return { ok: true, action: 'waitFor', loadState: p.loadState };
    }
    if (p.ms) {
      await settle(page, waitTimeout);
      return { ok: true, action: 'waitFor', ms: waitTimeout };
    }
    await page.waitForLoadState('networkidle', { timeout: waitTimeout }).catch(() => {});
    return { ok: true, action: 'waitFor', loadState: 'networkidle' };
  }

  if (decision.action === 'upload') {
    const { locator, element } = targetLocator(page, observation, decision.targetRef, 'upload');
    const paths = uploadPaths(decision, options);
    await locator.setInputFiles(paths, { timeout });
    return { ok: true, action: 'upload', targetRef: element.idRef, fileCount: paths.length };
  }

  return { ok: false, fallbackReason: `Unsupported AI action: ${decision.action}` };
}
