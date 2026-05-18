import { sanitizeUrl } from './url.js';

const RECORDER_BINDING = '__watRecordAction';

function sanitizeMaybeUrl(value) {
  if (!value) return '';
  try {
    return sanitizeUrl(value);
  } catch {
    return '';
  }
}

function normalizeEvent(event, seq, startedAt) {
  const normalized = {
    seq,
    type: event.type || 'unknown',
    phase: event.phase || 'manual-action',
    atMs: Number(event.atMs || 0),
    receivedMs: Date.now() - startedAt,
    frameUrl: sanitizeMaybeUrl(event.frameUrl),
    target: event.target || null
  };

  if (event.input) normalized.input = event.input;
  if (event.files) normalized.files = event.files;
  if (event.key) normalized.key = event.key;
  if (event.submitter) normalized.submitter = event.submitter;
  if (event.target?.href) {
    normalized.target = {
      ...event.target,
      href: sanitizeMaybeUrl(event.target.href)
    };
  }
  return normalized;
}

export async function installActionRecorder(page) {
  let startedAt = Date.now();
  const events = [];
  let seq = 1;
  let exposed = false;
  let installError = null;

  await page.exposeBinding(RECORDER_BINDING, async (_source, event) => {
    events.push(normalizeEvent(event || {}, seq++, startedAt));
  }).then(() => {
    exposed = true;
  }).catch(error => {
    if (!/already registered|has been already registered/i.test(error.message)) {
      throw error;
    }
    exposed = true;
  });

  const installer = bindingName => {
    if (window.__watActionRecorderInstalled) return;
    window.__watActionRecorderInstalled = true;
    window.__watActionEvents = window.__watActionEvents || [];
    const startedAt = performance.now();
    const RISK = /\b(log\s*in|sign\s*in|sign\s*up|authorize|oauth|captcha|verify|verification|password|passcode|2fa|mfa|account)\b|登录|登陆|注册|授权|验证码|验证|密码/i;

    function compact(value, max = 160) {
      return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
    }

    function className(el) {
      if (!el) return '';
      if (typeof el.className === 'string') return compact(el.className, 160);
      return compact(el.getAttribute?.('class'), 160);
    }

    function bbox(el) {
      if (!el?.getBoundingClientRect) return null;
      const rect = el.getBoundingClientRect();
      return {
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        width: Math.round(rect.width),
        height: Math.round(rect.height)
      };
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
          if (sameTag.length > 1) part += `:nth-of-type(${sameTag.indexOf(current) + 1})`;
        }
        parts.unshift(part);
        current = parent;
      }
      return parts.join(' > ');
    }

    function describe(el) {
      if (!(el instanceof Element)) return null;
      return {
        tag: el.localName,
        role: compact(el.getAttribute('role'), 60),
        type: compact(el.getAttribute('type'), 40),
        id: compact(el.id, 100),
        name: compact(el.getAttribute('name'), 80),
        className: className(el),
        text: compact(el.innerText || el.textContent, 160),
        ariaLabel: compact(el.getAttribute('aria-label'), 140),
        placeholder: compact(el.getAttribute('placeholder'), 140),
        href: el.href || '',
        cssPath: cssPath(el),
        bbox: bbox(el)
      };
    }

    function isSensitive(el) {
      if (!(el instanceof Element)) return true;
      const type = String(el.getAttribute('type') || '').toLowerCase();
      if (type === 'password' || type === 'hidden') return true;
      const blob = [
        el.localName,
        type,
        el.id,
        el.getAttribute('name'),
        el.getAttribute('aria-label'),
        el.getAttribute('placeholder'),
        el.innerText,
        el.textContent
      ].join(' ');
      return RISK.test(blob);
    }

    function valueInfo(el) {
      if (!(el instanceof Element)) return null;
      const sensitive = isSensitive(el);
      let value = '';
      if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
        value = el.value || '';
      } else if (el.isContentEditable) {
        value = el.innerText || el.textContent || '';
      }
      return {
        length: value.length,
        preview: sensitive ? '' : compact(value, 160),
        redacted: sensitive
      };
    }

    function eventTarget(event) {
      const path = event.composedPath?.();
      const original = path?.find(node => node instanceof Element);
      return original || event.target;
    }

    function emit(type, payload = {}) {
      const event = {
        type,
        atMs: Math.round(performance.now() - startedAt),
        frameUrl: location.href,
        ...payload
      };
      window.__watActionEvents.push(event);
      window[bindingName]?.(event).catch?.(() => {});
    }

    function recordActiveInput(reason) {
      let target = document.activeElement;
      while (target?.shadowRoot?.activeElement) {
        target = target.shadowRoot.activeElement;
      }
      if (!(target instanceof Element)) return;
      const info = valueInfo(target);
      if (!info || !info.length) return;
      emit('input-snapshot', { target: describe(target), input: info, reason });
    }

    const observedRoots = new WeakSet();

    function observeRoot(root) {
      if (!root || observedRoots.has(root)) return;
      observedRoots.add(root);

      root.addEventListener('click', event => {
        emit('click', { target: describe(eventTarget(event)) });
      }, true);

      root.addEventListener('input', event => {
        const target = eventTarget(event);
        emit('input', { target: describe(target), input: valueInfo(target) });
      }, true);

      root.addEventListener('change', event => {
        const target = eventTarget(event);
        if (target instanceof HTMLInputElement && target.type === 'file') {
          emit('file-change', {
            target: describe(target),
            files: Array.from(target.files || []).map(file => ({
              name: compact(file.name, 120),
              type: compact(file.type, 80),
              size: file.size
            }))
          });
        } else {
          emit('change', { target: describe(target), input: valueInfo(target) });
        }
      }, true);

      root.addEventListener('submit', event => {
        emit('submit', {
          target: describe(eventTarget(event)),
          submitter: describe(event.submitter)
        });
      }, true);

      root.addEventListener('keydown', event => {
        if (event.key === 'Enter' || event.key === 'Tab' || event.key === 'Escape') {
          emit('key', {
            target: describe(eventTarget(event)),
            key: {
              key: event.key,
              code: event.code,
              altKey: event.altKey,
              ctrlKey: event.ctrlKey,
              metaKey: event.metaKey,
              shiftKey: event.shiftKey
            }
          });
        }
      }, true);
    }

    function observeOpenShadowRoots(root = document) {
      observeRoot(root);
      const elements = root.querySelectorAll?.('*') || [];
      for (const el of elements) {
        if (el.shadowRoot) observeOpenShadowRoots(el.shadowRoot);
      }
    }

    observeOpenShadowRoots(document);

    const originalAttachShadow = Element.prototype.attachShadow;
    Element.prototype.attachShadow = function patchedAttachShadow(init) {
      const shadowRoot = originalAttachShadow.call(this, init);
      if (init?.mode === 'open') observeOpenShadowRoots(shadowRoot);
      return shadowRoot;
    };

    document.addEventListener('focusout', () => recordActiveInput('focusout'), true);
    window.addEventListener('pagehide', () => recordActiveInput('pagehide'), true);
    window.addEventListener('beforeunload', () => recordActiveInput('beforeunload'), true);
  };

  await page.addInitScript(installer, RECORDER_BINDING);
  await page.evaluate(installer, RECORDER_BINDING).catch(error => {
    installError = error.message;
  });

  return {
    async getEvents() {
      const pageEvents = await page.evaluate(() => window.__watActionEvents || []).catch(() => []);
      const merged = events.slice();
      for (const event of pageEvents) {
        merged.push(normalizeEvent(event || {}, seq++, startedAt));
      }
      const seen = new Set();
      const uniqueEvents = merged
        .sort((a, b) => a.receivedMs - b.receivedMs || a.atMs - b.atMs || a.seq - b.seq)
        .filter(event => {
          const key = [
            event.type,
            event.atMs,
            event.target?.cssPath,
            event.input?.preview,
            event.key?.key,
            event.files?.map(file => file.name).join(',')
          ].join('|');
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });

      const coalesced = [];
      for (const event of uniqueEvents) {
        const previous = coalesced[coalesced.length - 1];
        const sameInputTarget = previous &&
          event.type === 'input' &&
          previous.type === 'input' &&
          event.target?.cssPath &&
          event.target.cssPath === previous.target?.cssPath;
        if (sameInputTarget) {
          coalesced[coalesced.length - 1] = event;
        } else {
          coalesced.push(event);
        }
      }

      return coalesced.map((event, index) => ({ ...event, seq: index + 1 }));
    },
    async reset() {
      events.length = 0;
      seq = 1;
      startedAt = Date.now();
      await page.evaluate(() => {
        window.__watActionEvents = [];
      }).catch(() => {});
    },
    isInstalled() {
      return exposed && !installError;
    },
    getInstallError() {
      return installError;
    }
  };
}
