import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  applyLocatorValidation,
  loadLocatorValidationInputs,
  renderLocatorValidationMarkdown,
  validateInterfaceLocators,
  writeLocatorValidationArtifacts
} from '../src/locatorValidator.js';

function element(overrides = {}) {
  return {
    idRef: overrides.idRef || 'el_1',
    tag: overrides.tag || 'textarea',
    role: overrides.role || '',
    type: overrides.type || '',
    id: overrides.id || '',
    className: overrides.className || '',
    attributes: overrides.attributes || {},
    text: overrides.text || '',
    placeholder: overrides.placeholder || '',
    ariaLabel: overrides.ariaLabel || '',
    labelText: overrides.labelText || '',
    visible: overrides.visible ?? true,
    disabled: overrides.disabled ?? false,
    readOnly: overrides.readOnly ?? false,
    cssPath: overrides.cssPath || '',
    categories: overrides.categories || ['input']
  };
}

function elementsSnapshot(items) {
  return {
    all: items,
    inputs: items.filter(item => item.categories.includes('input')),
    buttons: items.filter(item => item.categories.includes('button')),
    fileInputs: items.filter(item => item.categories.includes('fileInput')),
    links: items.filter(item => item.categories.includes('link')),
    forms: [],
    outputContainers: items.filter(item => item.categories.includes('output'))
  };
}

function interfacePlan() {
  return {
    schemaVersion: 'web-adapter-tools.interface-plan.v2',
    operation: {
      name: 'send_message',
      transport: 'browser',
      template: 'dom_text',
      inputs: [
        {
          name: 'prompt',
          type: 'string',
          locator: { value: 'page.getByRole("textbox", { name: "Ask" })', confidence: 0.92 }
        }
      ],
      submit: {
        action: 'click',
        locator: { value: 'page.getByRole("button", { name: "Send" })', confidence: 0.9 }
      },
      outputs: [
        {
          name: 'result',
          type: 'text',
          locator: { value: 'page.locator("[aria-label=\\"Assistant result\\"]")', confidence: 0.5 }
        }
      ],
      setupSteps: [],
      waitSignals: [
        {
          type: 'dom-visible',
          locator: { value: 'page.locator("[aria-label=\\"Assistant result\\"]")', confidence: 0.5 }
        }
      ],
      extractors: [
        {
          name: 'result',
          type: 'text',
          strategy: 'dom-text',
          locator: { value: 'page.locator("[aria-label=\\"Assistant result\\"]")', confidence: 0.5 }
        }
      ],
      errorDetectors: []
    }
  };
}

test('validateInterfaceLocators scores unique stable locators and weak output locators', () => {
  const before = {
    name: 'before',
    elements: [
      element({ idRef: 'el_1', tag: 'textarea', role: '', placeholder: 'Ask', labelText: 'Ask', cssPath: '#prompt', categories: ['input'] }),
      element({ idRef: 'el_2', tag: 'button', text: 'Send', ariaLabel: 'Send', cssPath: '#send', categories: ['button'] })
    ]
  };
  const after = {
    name: 'after',
    elements: [
      ...before.elements,
      element({ idRef: 'el_3', tag: 'section', text: 'Answered.', ariaLabel: 'Assistant result', className: 'assistant-message', cssPath: '.assistant-message', categories: ['output'] })
    ]
  };

  const validation = validateInterfaceLocators(interfacePlan(), [before, after], { minScore: 70 });
  const input = validation.results.find(result => result.path === 'operation.inputs[0].locator');
  const output = validation.results.find(result => result.path === 'operation.outputs[0].locator');

  assert.equal(validation.locatorCount, 5);
  assert.equal(input.status, 'stable');
  assert.ok(input.stableScore >= 80);
  assert.equal(output.status, 'warning');
  assert.ok(output.warnings.some(warning => /every available snapshot/.test(warning)));
  assert.match(renderLocatorValidationMarkdown(validation), /Locator Validation/);
});

test('loadLocatorValidationInputs writes artifacts and annotates interface plans', async () => {
  const captureDir = await fs.mkdtemp(path.join(os.tmpdir(), 'web-adapter-tools-locator-validation-'));
  await fs.mkdir(path.join(captureDir, 'elements'), { recursive: true });
  const beforeElements = elementsSnapshot([
    element({ idRef: 'el_1', tag: 'textarea', placeholder: 'Ask', labelText: 'Ask', cssPath: '#prompt', categories: ['input'] }),
    element({ idRef: 'el_2', tag: 'button', text: 'Send', ariaLabel: 'Send', cssPath: '#send', categories: ['button'] })
  ]);
  const afterElements = elementsSnapshot([
    ...beforeElements.all,
    element({ idRef: 'el_3', tag: 'section', ariaLabel: 'Assistant result', className: 'assistant-message', text: 'Answered.', cssPath: '.assistant-message', categories: ['output'] })
  ]);
  await fs.writeFile(path.join(captureDir, 'profile.json'), JSON.stringify({
    files: {
      beforeElements: 'elements/before.json',
      elements: 'elements/after.json'
    }
  }), 'utf8');
  await fs.writeFile(path.join(captureDir, 'elements/before.json'), JSON.stringify(beforeElements), 'utf8');
  await fs.writeFile(path.join(captureDir, 'elements/after.json'), JSON.stringify(afterElements), 'utf8');
  await fs.writeFile(path.join(captureDir, 'interface.json'), JSON.stringify(interfacePlan()), 'utf8');

  const { plan, snapshots } = await loadLocatorValidationInputs(captureDir);
  assert.equal(snapshots.length, 2);
  const validation = validateInterfaceLocators(plan, snapshots);
  const artifacts = await writeLocatorValidationArtifacts(validation, captureDir);
  const annotated = applyLocatorValidation(plan, validation);

  assert.ok(await fs.readFile(artifacts.jsonPath, 'utf8'));
  assert.equal(annotated.locatorValidation.locatorCount, validation.locatorCount);
  assert.equal(annotated.operation.inputs[0].locator.stability.status, 'stable');
});
