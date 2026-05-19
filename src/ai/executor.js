const SAFE_ACTIONS = new Set(['fill', 'click', 'press', 'wait']);
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

function assertSafeElement(element, action) {
  if (!element) throw new Error('AI decision targetRef was not found in the current observation');
  if (!element.cssPath) throw new Error(`Target ${element.idRef} does not have a cssPath`);
  if (element.risk || RISK_PATTERN.test(elementText(element))) {
    throw new Error(`Target ${element.idRef} looks sensitive or risky`);
  }
  if (element.disabled) throw new Error(`Target ${element.idRef} is disabled`);
  if (!element.visible && action !== 'wait') throw new Error(`Target ${element.idRef} is not visible`);
  if (action === 'fill' && element.readOnly) throw new Error(`Target ${element.idRef} is read-only`);
}

function targetLocator(page, observation, targetRef, action) {
  const element = observation.targetMap.get(targetRef);
  assertSafeElement(element, action);
  return {
    element,
    locator: page.locator(element.cssPath).first()
  };
}

export function shouldFallbackDecision(decision, options = {}) {
  const minConfidence = Number(options.minConfidence ?? 0.7);
  if (!decision || typeof decision !== 'object') return 'AI decision is empty';
  if (decision.mode === 'ask_user') return decision.reason || 'AI requested human assistance';
  if (decision.mode === 'finish') return '';
  if (decision.mode !== 'execute') return `Unsupported AI decision mode: ${decision.mode}`;
  if (!SAFE_ACTIONS.has(decision.action)) return `Unsupported AI action: ${decision.action}`;
  if (Number(decision.confidence || 0) < minConfidence) {
    return `AI confidence ${decision.confidence || 0} is below ${minConfidence}`;
  }
  if (['fill', 'click'].includes(decision.action) && !decision.targetRef) {
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
    const value = decision.valueFrom === 'aiInput' ? observation.aiInput : decision.value;
    await locator.fill('');
    await locator.fill(String(value || ''));
    return { ok: true, action: 'fill', targetRef: element.idRef, valueLength: String(value || '').length };
  }

  if (decision.action === 'click') {
    const { locator, element } = targetLocator(page, observation, decision.targetRef, 'click');
    await locator.waitFor({ state: 'visible', timeout });
    await locator.click({ timeout });
    return { ok: true, action: 'click', targetRef: element.idRef };
  }

  if (decision.action === 'press') {
    const key = compact(decision.key || 'Enter', 40);
    if (decision.targetRef) {
      const { locator, element } = targetLocator(page, observation, decision.targetRef, 'press');
      await locator.waitFor({ state: 'visible', timeout });
      await locator.press(key);
      return { ok: true, action: 'press', targetRef: element.idRef, key };
    }
    await page.keyboard.press(key);
    return { ok: true, action: 'press', key };
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

  return { ok: false, fallbackReason: `Unsupported AI action: ${decision.action}` };
}
