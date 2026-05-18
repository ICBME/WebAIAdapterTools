import { generateLocatorCandidates, inferRole } from './locators.js';

const RISK_PATTERN = /\b(log\s*in|sign\s*in|sign\s*up|authorize|oauth|captcha|verify|verification|password|passcode|2fa|mfa|account)\b|登录|登陆|注册|授权|验证码|验证|密码/i;
const INPUT_PATTERN = /\b(prompt|message|ask|chat|describe|question|tell|write|输入|提问|描述|消息)\b/i;
const UPLOAD_PATTERN = /\b(upload|attach|attachment|file|media|paperclip|reference)\b|\b(search\s+using\s+an\s+image|image\s+upload|upload\s+image|attach\s+image|reference\s+image)\b|上传|附件|图片上传|上传图片|文件|参考图/i;
const SUBMIT_PATTERN = /\b(send|generate|create|submit|run|start|go|arrow_forward|发送|生成|创建|提交|开始)\b/i;
const OUTPUT_PATTERN = /\b(output|result|response|assistant|message|conversation|chat|answer|content|completion|输出|结果|回复|回答|消息|会话)\b/i;
const OUTPUT_NOISE_TAGS = new Set(['html', 'head', 'body', 'script', 'style', 'meta', 'link', 'noscript', 'template', 'label', 'input', 'textarea', 'button', 'select', 'option']);

function textBlob(element) {
  return [
    element.text,
    element.placeholder,
    element.ariaLabel,
    element.labelText,
    element.id,
    element.className,
    element.name
  ].filter(Boolean).join(' ');
}

function directTextBlob(element) {
  return [
    element.text,
    element.placeholder,
    element.ariaLabel,
    element.id,
    element.className,
    element.name
  ].filter(Boolean).join(' ');
}

function addScore(result, amount, reason) {
  if (!amount) return;
  result.score += amount;
  result.reasons.push(`${amount > 0 ? '+' : ''}${amount}: ${reason}`);
}

function finalize(result) {
  result.score = Math.max(0, Math.min(100, Math.round(result.score)));
  return result;
}

export function hasRiskKeyword(element) {
  return RISK_PATTERN.test(textBlob(element));
}

export function scoreInputCandidate(element) {
  const result = { score: 0, reasons: [] };
  const role = inferRole(element);
  const text = textBlob(element);
  const type = String(element.type || '').toLowerCase();

  if (element.tag === 'textarea') addScore(result, 35, 'textarea');
  if (role === 'textbox') addScore(result, 28, 'textbox role');
  if (element.contentEditable) addScore(result, 28, 'contenteditable');
  if (/prosemirror/i.test(element.className || '')) addScore(result, 24, 'ProseMirror editor');
  if (INPUT_PATTERN.test(text)) addScore(result, 16, 'input-related label text');
  if (element.visible) addScore(result, 10, 'visible');
  if (!element.disabled && !element.readOnly) addScore(result, 10, 'editable');
  if (type === 'file') addScore(result, -60, 'file input is not prompt input');
  if (type === 'hidden') addScore(result, -60, 'hidden input');
  if (type === 'password') addScore(result, -70, 'password input');
  if (hasRiskKeyword(element)) addScore(result, -45, 'login/auth/captcha keyword');

  return finalize(result);
}

export function scoreUploadCandidate(element) {
  const result = { score: 0, reasons: [] };
  const role = inferRole(element);
  const text = textBlob(element);
  const directText = directTextBlob(element);
  const type = String(element.type || '').toLowerCase();

  if (element.tag === 'input' && type === 'file') addScore(result, 60, 'native file input');
  if (['button', 'link', 'menuitem'].includes(role)) addScore(result, 18, 'clickable upload trigger');
  if (UPLOAD_PATTERN.test(directText)) {
    addScore(result, 35, 'upload-related control text');
  } else if (element.tag === 'input' && type === 'file' && UPLOAD_PATTERN.test(text)) {
    addScore(result, 12, 'upload-related nearby label text');
  }
  if (element.visible) addScore(result, 10, 'visible');
  if (element.disabled) addScore(result, -20, 'disabled');
  if (hasRiskKeyword(element)) addScore(result, -50, 'login/auth/captcha keyword');

  return finalize(result);
}

export function scoreSubmitCandidate(element) {
  const result = { score: 0, reasons: [] };
  const role = inferRole(element);
  const text = textBlob(element);
  const directText = directTextBlob(element);
  const type = String(element.type || '').toLowerCase();

  if (role === 'button') addScore(result, 25, 'button role');
  if (['submit', 'image'].includes(type)) addScore(result, 20, `input type ${type}`);
  if (type === 'submit') addScore(result, 18, 'submit type');
  if (SUBMIT_PATTERN.test(directText)) {
    addScore(result, 35, 'submit-related control text');
  } else if (element.tag === 'input' && type === 'submit' && SUBMIT_PATTERN.test(text)) {
    addScore(result, 10, 'submit-related nearby label text');
  }
  if (element.visible) addScore(result, 10, 'visible');
  if (!element.visible) addScore(result, -80, 'not visible');
  if (!text.trim() && !element.ariaLabel && !element.labelText && !element.id && type === 'submit') {
    addScore(result, -25, 'hidden unlabeled submit is usually a fallback control');
  }
  if (element.disabled) addScore(result, -8, 'currently disabled');
  if (hasRiskKeyword(element)) addScore(result, -60, 'login/auth/captcha keyword');

  return finalize(result);
}

export function scoreOutputCandidate(element) {
  const result = { score: 0, reasons: [] };
  const role = inferRole(element);
  const text = textBlob(element);

  if (OUTPUT_NOISE_TAGS.has(element.tag)) addScore(result, -80, 'document/script/style noise');
  if (element.ariaLive) addScore(result, 35, 'aria-live region');
  if (element.visible && OUTPUT_PATTERN.test(text)) addScore(result, 28, 'output-related label text');
  if (['log', 'status', 'main', 'article'].includes(role)) addScore(result, 14, 'semantic output role');
  if (['main', 'section', 'article'].includes(element.tag)) addScore(result, 8, 'content container tag');
  if (element.visible) addScore(result, 10, 'visible');
  if (!element.visible && !element.ariaLive) addScore(result, -25, 'not visible');
  if (element.categories?.includes('input') || element.categories?.includes('button')) addScore(result, -25, 'interactive control, unlikely output');
  if (hasRiskKeyword(element)) addScore(result, -20, 'login/auth/captcha keyword');

  return finalize(result);
}

function buildRecommendation(type, element, scoring) {
  return {
    type,
    elementId: element.idRef,
    score: scoring.score,
    reasons: scoring.reasons,
    element: {
      tag: element.tag,
      role: element.role || inferRole(element),
      type: element.type || null,
      text: element.text || '',
      placeholder: element.placeholder || '',
      ariaLabel: element.ariaLabel || '',
      labelText: element.labelText || '',
      visible: element.visible,
      disabled: element.disabled,
      bbox: element.bbox
    },
    locatorCandidates: generateLocatorCandidates(element).slice(0, 6)
  };
}

function topCandidates(elements, type, scorer, allowedCategories, minScore = 1) {
  return elements
    .filter(element => allowedCategories.some(category => element.categories?.includes(category)))
    .map(element => buildRecommendation(type, element, scorer(element)))
    .filter(item => item.score >= minScore)
    .sort((a, b) => b.score - a.score)
    .slice(0, 8);
}

export function buildRecommendations(elements) {
  return {
    inputs: topCandidates(elements, 'input', scoreInputCandidate, ['input']),
    uploads: topCandidates(elements, 'upload', scoreUploadCandidate, ['fileInput', 'button', 'link'], 40),
    submits: topCandidates(elements, 'submit', scoreSubmitCandidate, ['button']),
    outputs: topCandidates(elements, 'output', scoreOutputCandidate, ['output'])
  };
}
