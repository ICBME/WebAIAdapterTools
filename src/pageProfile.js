import { sanitizeUrl } from './url.js';
import { buildRecommendations } from './scoring.js';

function normalizeElements(elements) {
  return elements.map(element => {
    const normalized = { ...element };
    if (normalized.href) normalized.href = sanitizeUrl(normalized.href);
    return normalized;
  });
}

export async function collectPageSnapshot(page, capture = {}) {
  const raw = await page.evaluate(() => {
    const MAX_TEXT = 160;
    const MAX_ELEMENTS = 350;
    const OUTPUT_HINT = /chat|message|conversation|result|response|output|assistant|answer|completion|thread|history|内容|消息|结果|回复|回答|会话/i;

    function compact(value, max = MAX_TEXT) {
      return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
    }

    function attrMap(el) {
      const attrs = {};
      for (const name of ['data-testid', 'data-test', 'data-cy']) {
        const value = el.getAttribute(name);
        if (value) attrs[name] = compact(value, 120);
      }
      return attrs;
    }

    function getClassName(el) {
      if (typeof el.className === 'string') return compact(el.className, 180);
      return compact(el.getAttribute('class'), 180);
    }

    function isVisible(el) {
      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.display !== 'none' &&
        style.visibility !== 'hidden' &&
        Number(style.opacity || 1) > 0 &&
        rect.width > 0 &&
        rect.height > 0;
    }

    function bbox(el) {
      const rect = el.getBoundingClientRect();
      return {
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        width: Math.round(rect.width),
        height: Math.round(rect.height)
      };
    }

    function labelText(el) {
      const labelledBy = el.getAttribute('aria-labelledby');
      if (labelledBy) {
        const text = labelledBy
          .split(/\s+/)
          .map(id => document.getElementById(id)?.innerText || document.getElementById(id)?.textContent || '')
          .join(' ');
        if (compact(text)) return compact(text);
      }

      if (el.id) {
        const explicit = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
        if (explicit) return compact(explicit.innerText || explicit.textContent);
      }

      const parentLabel = el.closest('label');
      if (parentLabel) return compact(parentLabel.innerText || parentLabel.textContent);

      const container = el.closest('div, section, form, label, article');
      if (container) {
        const nearby = Array.from(container.querySelectorAll('label, [aria-label], [class*="label" i]'))
          .slice(0, 3)
          .map(node => node.getAttribute('aria-label') || node.innerText || node.textContent || '')
          .join(' ');
        return compact(nearby);
      }
      return '';
    }

    function cssPath(el) {
      if (!(el instanceof Element)) return '';
      if (el.id) return `#${CSS.escape(el.id)}`;

      const parts = [];
      let current = el;
      while (current && current.nodeType === Node.ELEMENT_NODE && current !== document.body && parts.length < 5) {
        const tag = current.localName;
        const testId = current.getAttribute('data-testid') || current.getAttribute('data-test') || current.getAttribute('data-cy');
        if (testId) {
          parts.unshift(`${tag}[data-testid="${CSS.escape(testId)}"]`);
          break;
        }
        const cls = Array.from(current.classList || []).filter(c => /^[A-Za-z][A-Za-z0-9_-]{1,40}$/.test(c)).slice(0, 2);
        let part = tag + (cls.length ? `.${cls.map(c => CSS.escape(c)).join('.')}` : '');
        const parent = current.parentElement;
        if (parent) {
          const sameTag = Array.from(parent.children).filter(child => child.localName === tag);
          if (sameTag.length > 1) {
            part += `:nth-of-type(${sameTag.indexOf(current) + 1})`;
          }
        }
        parts.unshift(part);
        current = parent;
      }
      return parts.join(' > ');
    }

    function categoriesFor(el) {
      const tag = el.localName;
      const role = compact(el.getAttribute('role'), 60).toLowerCase();
      const type = compact(el.getAttribute('type'), 40).toLowerCase();
      const className = getClassName(el);
      const visible = isVisible(el);
      const textBlob = [
        tag,
        role,
        type,
        el.id,
        className,
        el.getAttribute('aria-label'),
        el.getAttribute('placeholder'),
        el.innerText,
        el.textContent
      ].join(' ');
      const categories = [];

      if (tag === 'textarea' ||
        (tag === 'input' && ['', 'text', 'search', 'email', 'url', 'tel', 'password', 'number'].includes(type)) ||
        el.isContentEditable ||
        role === 'textbox' ||
        /(^|\s)ProseMirror(\s|$)/.test(className)) {
        categories.push('input');
      }
      if (tag === 'input' && type === 'file') categories.push('fileInput');
      if (tag === 'button' || role === 'button' || (tag === 'input' && ['submit', 'button', 'image'].includes(type))) categories.push('button');
      if (tag === 'a' && el.href) categories.push('link');
      if (tag === 'form') categories.push('form');
      const isDocumentNoise = ['html', 'head', 'body', 'script', 'style', 'meta', 'link', 'noscript', 'template'].includes(tag);
      const isInteractiveOrLabel = ['label', 'input', 'textarea', 'button', 'select', 'option'].includes(tag) || ['button', 'textbox', 'combobox', 'link'].includes(role);
      const isContentContainer = ['div', 'main', 'section', 'article', 'ul', 'ol', 'li', 'p'].includes(tag);
      const isOutputLike = el.getAttribute('aria-live') ||
        ['log', 'status', 'main', 'article'].includes(role) ||
        ['main', 'section', 'article'].includes(tag) ||
        (visible && isContentContainer && OUTPUT_HINT.test(textBlob));
      if (!isDocumentNoise && !isInteractiveOrLabel && isOutputLike) {
        categories.push('output');
      }
      return categories;
    }

    const collected = [];
    let shadowRoots = 0;

    function visit(root, shadowDepth = 0) {
      const all = Array.from(root.querySelectorAll('*'));
      for (const el of all) {
        if (collected.length >= MAX_ELEMENTS) return;
        const categories = categoriesFor(el);
        if (categories.length) {
          const type = compact(el.getAttribute('type'), 40).toLowerCase();
          collected.push({
            idRef: `el_${collected.length + 1}`,
            tag: el.localName,
            role: compact(el.getAttribute('role'), 60),
            type,
            name: compact(el.getAttribute('name'), 80),
            id: compact(el.id, 100),
            className: getClassName(el),
            attributes: attrMap(el),
            text: compact(el.innerText || el.textContent),
            placeholder: compact(el.getAttribute('placeholder'), 140),
            ariaLabel: compact(el.getAttribute('aria-label'), 140),
            ariaLive: compact(el.getAttribute('aria-live'), 50),
            labelText: labelText(el),
            href: el.href || '',
            contentEditable: Boolean(el.isContentEditable),
            disabled: Boolean(el.disabled || el.getAttribute('aria-disabled') === 'true'),
            readOnly: Boolean(el.readOnly),
            visible: isVisible(el),
            bbox: bbox(el),
            cssPath: cssPath(el),
            shadowDepth,
            categories
          });
        }
        if (el.shadowRoot) {
          shadowRoots++;
          visit(el.shadowRoot, shadowDepth + 1);
        }
      }
    }

    visit(document, 0);

    const bodyText = compact(document.body?.innerText || document.body?.textContent || '', 10000);
    return {
      page: {
        title: document.title || '',
        lang: document.documentElement.lang || '',
        url: location.href,
        readyState: document.readyState,
        hasBody: Boolean(document.body),
        textStats: {
          characters: bodyText.length,
          words: bodyText ? bodyText.split(/\s+/).filter(Boolean).length : 0,
          preview: bodyText.slice(0, 500)
        },
        counts: {
          elements: document.querySelectorAll('*').length,
          forms: document.forms.length,
          iframes: document.querySelectorAll('iframe').length,
          shadowRoots
        }
      },
      elements: collected
    };
  });

  const elements = normalizeElements(raw.elements);
  return {
    schemaVersion: 'web-adapter-tools.profile.v1',
    capture,
    page: {
      ...raw.page,
      url: sanitizeUrl(raw.page.url)
    },
    elements: {
      all: elements,
      inputs: elements.filter(el => el.categories.includes('input')),
      buttons: elements.filter(el => el.categories.includes('button')),
      fileInputs: elements.filter(el => el.categories.includes('fileInput')),
      links: elements.filter(el => el.categories.includes('link')),
      forms: elements.filter(el => el.categories.includes('form')),
      outputContainers: elements.filter(el => el.categories.includes('output'))
    },
    recommendations: buildRecommendations(elements)
  };
}
