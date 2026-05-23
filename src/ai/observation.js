const MAX_ELEMENTS = 80;
const RISK_PATTERN = /\b(log\s*in|sign\s*in|sign\s*up|authorize|oauth|captcha|verify|verification|password|passcode|2fa|mfa|account|payment|purchase|delete|remove)\b|登录|登陆|注册|授权|验证码|验证|密码|支付|购买|删除/i;

function compact(value, max = 180) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function candidateElementIds(recommendations = {}) {
  const ids = new Set();
  for (const group of ['inputs', 'uploads', 'submits', 'outputs']) {
    for (const item of recommendations[group] || []) {
      if (item.elementId) ids.add(item.elementId);
    }
  }
  return ids;
}

function elementText(element) {
  return [
    element.text,
    element.placeholder,
    element.ariaLabel,
    element.labelText,
    element.id,
    element.name,
    element.className
  ].filter(Boolean).join(' ');
}

function summarizeElement(element) {
  return {
    idRef: element.idRef,
    categories: element.categories || [],
    tag: element.tag || '',
    role: element.role || '',
    type: element.type || '',
    name: element.name || '',
    text: compact(element.text),
    placeholder: compact(element.placeholder),
    ariaLabel: compact(element.ariaLabel),
    labelText: compact(element.labelText),
    visible: Boolean(element.visible),
    disabled: Boolean(element.disabled),
    readOnly: Boolean(element.readOnly),
    cssPath: element.cssPath || '',
    bbox: element.bbox || null,
    risk: RISK_PATTERN.test(elementText(element))
  };
}

function summarizeRecommendation(item) {
  return {
    elementId: item.elementId,
    score: item.score,
    reasons: item.reasons || [],
    element: item.element || null
  };
}

export function buildAiObservation(snapshot, options = {}) {
  const recommendations = snapshot?.recommendations || {};
  const priorityIds = candidateElementIds(recommendations);
  const all = snapshot?.elements?.all || [];
  const elements = all
    .filter(element => priorityIds.has(element.idRef) || (element.categories || []).some(category => (
      category === 'input' || category === 'button' || category === 'fileInput' || category === 'output'
    )))
    .slice(0, MAX_ELEMENTS)
    .map(summarizeElement);

  const targetMap = new Map(elements.map(element => [element.idRef, element]));
  const riskElements = elements.filter(element => element.risk);

  return {
    schemaVersion: 'web-adapter-tools.ai-observation.v1',
    goal: options.goal || '',
    aiInput: options.aiInput || '',
    adapterPlan: options.adapterPlan || null,
    mode: options.mode || 'hybrid',
    stepIndex: options.stepIndex || 1,
    maxSteps: options.maxSteps || 8,
    previousSteps: options.previousSteps || [],
    page: {
      title: snapshot?.page?.title || '',
      url: snapshot?.page?.url?.display || snapshot?.page?.url || '',
      readyState: snapshot?.page?.readyState || '',
      textPreview: compact(snapshot?.page?.textStats?.preview, 600),
      counts: snapshot?.page?.counts || {}
    },
    recommendations: {
      inputs: (recommendations.inputs || []).slice(0, 5).map(summarizeRecommendation),
      submits: (recommendations.submits || []).slice(0, 5).map(summarizeRecommendation),
      outputs: (recommendations.outputs || []).slice(0, 5).map(summarizeRecommendation),
      uploads: (recommendations.uploads || []).slice(0, 3).map(summarizeRecommendation)
    },
    elements,
    risk: {
      hasRisk: riskElements.length > 0,
      elements: riskElements.slice(0, 8).map(element => ({
        idRef: element.idRef,
        categories: element.categories,
        text: compact(`${element.ariaLabel} ${element.placeholder} ${element.text}`),
        cssPath: element.cssPath
      }))
    },
    targetMap
  };
}

export function serializeObservationForAi(observation) {
  const { targetMap, ...serializable } = observation;
  return serializable;
}
