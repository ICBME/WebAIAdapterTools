import test from 'node:test';
import assert from 'node:assert/strict';
import { scoreInputCandidate, scoreOutputCandidate, scoreSubmitCandidate, scoreUploadCandidate } from '../src/scoring.js';

test('input scoring rewards prompt fields and penalizes auth fields', () => {
  const prompt = {
    tag: 'textarea',
    role: '',
    type: '',
    placeholder: 'Ask anything',
    text: '',
    className: '',
    visible: true,
    disabled: false,
    readOnly: false
  };
  const password = {
    tag: 'input',
    role: '',
    type: 'password',
    placeholder: 'Password',
    text: '',
    className: '',
    visible: true,
    disabled: false,
    readOnly: false
  };

  assert.ok(scoreInputCandidate(prompt).score > 70);
  assert.ok(scoreInputCandidate(password).score < 30);
});

test('upload and submit scoring identify common controls', () => {
  const upload = {
    tag: 'button',
    role: '',
    type: 'button',
    ariaLabel: 'Attach image',
    text: '',
    className: '',
    visible: true,
    disabled: false
  };
  const submit = {
    tag: 'button',
    role: '',
    type: 'submit',
    ariaLabel: 'Send message',
    text: 'Send',
    className: '',
    visible: true,
    disabled: false
  };
  const login = {
    tag: 'button',
    role: '',
    type: 'button',
    ariaLabel: 'Sign in',
    text: 'Sign in',
    className: '',
    visible: true,
    disabled: false
  };

  assert.ok(scoreUploadCandidate(upload).score >= 50);
  assert.ok(scoreSubmitCandidate(submit).score >= 70);
  assert.ok(scoreSubmitCandidate(login).score < scoreSubmitCandidate(submit).score);
});

test('submit scoring downgrades invisible fallback submit controls', () => {
  const hiddenSubmit = {
    tag: 'input',
    role: '',
    type: 'submit',
    ariaLabel: '',
    labelText: '',
    text: '',
    id: '',
    className: '',
    visible: false,
    disabled: false
  };
  const visibleVoiceButton = {
    tag: 'div',
    role: 'button',
    type: '',
    ariaLabel: 'Search using voice',
    labelText: '',
    text: '',
    id: '',
    className: '',
    visible: true,
    disabled: false
  };

  assert.ok(scoreSubmitCandidate(hiddenSubmit).score < scoreSubmitCandidate(visibleVoiceButton).score);
});

test('output scoring filters document and script noise', () => {
  const script = {
    tag: 'script',
    role: '',
    type: 'text/javascript',
    text: 'assistant response message output',
    className: '',
    categories: ['output'],
    visible: false,
    ariaLive: ''
  };
  const liveRegion = {
    tag: 'section',
    role: '',
    type: '',
    text: '',
    className: '',
    categories: ['output'],
    visible: true,
    ariaLive: 'polite'
  };

  assert.equal(scoreOutputCandidate(script).score, 0);
  assert.ok(scoreOutputCandidate(liveRegion).score > 40);
});
