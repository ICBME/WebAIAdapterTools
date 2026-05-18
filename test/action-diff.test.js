import test from 'node:test';
import assert from 'node:assert/strict';
import { diffSnapshots } from '../src/actionDiff.js';

test('diffSnapshots reports added elements and url changes', () => {
  const before = {
    page: { url: { display: 'https://example.com/' }, title: 'Before' },
    elements: {
      all: [
        { idRef: 'el_1', tag: 'textarea', role: '', type: '', id: 'prompt', name: '', ariaLabel: '', placeholder: '', cssPath: '#prompt', text: '', visible: true, categories: ['input'], bbox: {} }
      ]
    }
  };
  const after = {
    page: { url: { display: 'https://example.com/result' }, title: 'After' },
    elements: {
      all: [
        { idRef: 'el_1', tag: 'textarea', role: '', type: '', id: 'prompt', name: '', ariaLabel: '', placeholder: '', cssPath: '#prompt', text: '', visible: true, categories: ['input'], bbox: {} },
        { idRef: 'el_2', tag: 'article', role: '', type: '', id: '', name: '', ariaLabel: '', placeholder: '', cssPath: 'article.result', text: 'Answer', visible: true, categories: ['output'], bbox: {} }
      ]
    }
  };

  const diff = diffSnapshots(before, after);
  assert.equal(diff.urlChanged, true);
  assert.equal(diff.pageTitleChanged, true);
  assert.equal(diff.counts.addedElements, 1);
  assert.equal(diff.addedElements[0].text, 'Answer');
});
