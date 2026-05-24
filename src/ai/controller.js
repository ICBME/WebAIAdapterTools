import { collectPageSnapshot } from '../pageProfile.js';
import { buildAiObservation, serializeObservationForAi } from './observation.js';
import { createAiProvider, normalizeAiDecision, resolveAiTimeout } from './provider.js';
import { executeAiDecision, shouldFallbackDecision } from './executor.js';

function compact(value, max = 500) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function fallbackInstruction(decision, reason, options) {
  if (decision?.userInstruction) return decision.userInstruction;
  const inputText = options.aiInput ? ` 使用测试输入 "${compact(options.aiInput, 120)}"。` : '';
  return `AI 无法可靠完成当前步骤：${reason || '目标不明确'}。请根据目标手动完成下一步：${compact(options.goal, 240)}。${inputText}完成页面变化后点击完成或在终端按 Enter。`;
}

async function waitForHumanAssistance(page, options, instruction, stepIndex) {
  const controlPanel = options.controlPanel || null;
  if (controlPanel) {
    await controlPanel.setState({
      phase: 'assist',
      actionIndex: stepIndex,
      label: `ai-assist-${stepIndex}`,
      message: instruction
    });
    const signal = await controlPanel.waitFor(['assist-done', 'assist-retry', 'assist-abort']);
    if (signal.type === 'assist-abort') throw new Error('Human aborted AI-assisted capture');
    return { type: signal.type, label: signal.label || '' };
  }

  if (options.waitForUser) {
    await options.waitForUser(page, 'ai-assist', {
      actionIndex: stepIndex,
      instruction,
      goal: options.goal,
      aiInput: options.aiInput
    });
    return { type: 'assist-done', label: '' };
  }

  throw new Error(`Human fallback is required but no human control channel is available. Instruction: ${instruction}`);
}

async function decide(provider, observation, options) {
  if (options.mode === 'assist') {
    return normalizeAiDecision({
      mode: 'ask_user',
      confidence: 1,
      userInstruction: `请手动完成目标动作：${compact(options.goal, 240)}${options.aiInput ? `。测试输入：${compact(options.aiInput, 120)}` : ''}`,
      reason: 'assist mode'
    });
  }
  const serialized = serializeObservationForAi(observation);
  return normalizeAiDecision(await provider.decide(serialized));
}

export async function runAiHybridAction(page, options = {}) {
  const mode = options.mode || 'hybrid';
  const maxSteps = Math.max(1, Number(options.maxSteps || 8));
  const aiTimeout = resolveAiTimeout(options);
  const provider = options.provider || await createAiProvider({
    providerType: options.providerType,
    baseUrl: options.baseUrl,
    apiKey: options.apiKey,
    model: options.model,
    timeout: aiTimeout
  });
  const steps = [];
  let completed = false;
  let fallbackCount = 0;
  let lastObservation = null;

  for (let stepIndex = 1; stepIndex <= maxSteps; stepIndex++) {
    const snapshot = await collectPageSnapshot(page, {
      initialUrl: options.initialUrl || null,
      finalUrl: page.url(),
      capturedAt: new Date().toISOString(),
      viewport: page.viewportSize(),
      options: options.captureOptions || {},
      phase: `aiStep:${stepIndex}`
    });
    const observation = buildAiObservation(snapshot, {
      goal: options.goal,
      aiInput: options.aiInput,
      mode,
      stepIndex,
      maxSteps,
      adapterPlan: options.adapterPlan || null,
      previousSteps: steps.slice(-6).map(step => ({
        index: step.index,
        actor: step.actor,
        action: step.action,
        mode: step.mode,
        ok: step.ok,
        reason: step.reason || step.fallbackReason || ''
      }))
    });
    lastObservation = serializeObservationForAi(observation);

    let decision;
    try {
      decision = await decide(provider, observation, { ...options, mode });
    } catch (error) {
      decision = normalizeAiDecision({
        mode: mode === 'auto' ? 'execute' : 'ask_user',
        confidence: 0,
        userInstruction: fallbackInstruction(null, error.message, options),
        reason: error.message
      });
    }

    if (decision.mode === 'finish') {
      completed = true;
      steps.push({
        index: stepIndex,
        actor: 'ai',
        mode: decision.mode,
        action: 'finish',
        confidence: decision.confidence,
        ok: true,
        reason: decision.reason || ''
      });
      break;
    }

    const fallbackReason = mode === 'auto' ? shouldFallbackDecision(decision, options) : (
      decision.mode === 'ask_user' ? (decision.reason || 'AI requested human assistance') : shouldFallbackDecision(decision, options)
    );
    if (decision.mode === 'ask_user' || fallbackReason) {
      if (mode === 'auto') {
        throw new Error(`AI auto capture failed: ${fallbackReason || decision.reason || 'human assistance requested'}`);
      }
      fallbackCount += 1;
      const instruction = fallbackInstruction(decision, fallbackReason || decision.reason, options);
      const signal = await waitForHumanAssistance(page, options, instruction, stepIndex);
      steps.push({
        index: stepIndex,
        actor: 'human',
        mode: 'ask_user',
        action: 'manual',
        ok: true,
        fallbackReason: fallbackReason || decision.reason || '',
        instruction,
        signal
      });
      await page.waitForLoadState('networkidle', { timeout: aiTimeout }).catch(() => {});
      if (mode === 'assist') {
        completed = true;
        break;
      }
      continue;
    }

    const execution = await executeAiDecision(page, observation, decision, {
      timeout: aiTimeout,
      minConfidence: options.minConfidence
    });

    if (!execution.ok) {
      if (mode === 'auto') throw new Error(`AI action failed: ${execution.fallbackReason}`);
      fallbackCount += 1;
      const instruction = fallbackInstruction(decision, execution.fallbackReason, options);
      const signal = await waitForHumanAssistance(page, options, instruction, stepIndex);
      steps.push({
        index: stepIndex,
        actor: 'human',
        mode: 'ask_user',
        action: 'manual',
        ok: true,
        fallbackReason: execution.fallbackReason,
        instruction,
        signal
      });
    } else {
      steps.push({
        index: stepIndex,
        actor: 'ai',
        mode: decision.mode,
        action: decision.action,
        targetRef: decision.targetRef || null,
        params: decision.params || {},
        key: decision.key || null,
        confidence: decision.confidence,
        ok: true,
        reason: decision.reason || '',
        execution
      });
      if (decision.waitAfter === 'networkidle') {
        await page.waitForLoadState('networkidle', { timeout: aiTimeout }).catch(() => {});
      }
    }
  }

  return {
    schemaVersion: 'web-adapter-tools.ai-controller.v1',
    mode,
    provider: provider.type || options.providerType || 'custom',
    timeoutMs: aiTimeout,
    goal: options.goal || '',
    inputPreview: compact(options.aiInput, 160),
    completed,
    fallbackCount,
    stepCount: steps.length,
    steps,
    lastObservation
  };
}
