const CONTROL_BINDING = '__watControlSignal';
const CONTROL_ID = '__wat_browser_controls';

function controlInstaller(config) {
  const bindingName = config.bindingName;
  const controlId = config.controlId;
  if (window.top !== window) return;
  if (window.__watBrowserControlsInstalled) return;
  window.__watBrowserControlsInstalled = true;
  window.__watControlState = window.__watControlState || {
    phase: 'prepare',
    actionIndex: 1,
    label: '',
    message: 'Prepare the page, then capture the baseline.'
  };
  window.__watControlSignals = window.__watControlSignals || [];

  function compact(value, max = 80) {
    return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
  }

  function emit(type, extra = {}) {
    const label = compact(document.getElementById(`${controlId}_label`)?.value || window.__watControlState.label);
    const payload = {
      type,
      actionIndex: window.__watControlState.actionIndex || 1,
      label,
      atMs: Math.round(performance.now()),
      url: location.href,
      ...extra
    };
    window.__watControlSignals.push(payload);
    window[bindingName]?.(payload).catch?.(() => {});
  }

  function button(id, text, primary = false) {
    return `<button id="${id}" type="button" style="
      appearance:none;border:1px solid ${primary ? '#14532d' : '#9ca3af'};
      background:${primary ? '#166534' : '#ffffff'};color:${primary ? '#ffffff' : '#111827'};
      border-radius:6px;padding:7px 9px;font:600 12px system-ui;cursor:pointer;
    ">${text}</button>`;
  }

  function render() {
    let root = document.getElementById(controlId);
    if (!root) {
      root = document.createElement('div');
      root.id = controlId;
      root.setAttribute('data-wat-control', 'true');
      root.style.cssText = [
        'position:fixed',
        'right:14px',
        'bottom:14px',
        'z-index:2147483647',
        'width:300px',
        'box-sizing:border-box',
        'padding:12px',
        'border:1px solid #111827',
        'border-radius:8px',
        'background:#f9fafb',
        'color:#111827',
        'font:13px system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif',
        'box-shadow:0 12px 32px rgba(0,0,0,.25)'
      ].join(';');
      document.documentElement.appendChild(root);
    }

    const state = window.__watControlState;
    const label = compact(state.label);
    let body = '';
    if (state.phase === 'prepare') {
      body = `
        <div style="display:flex;gap:8px;align-items:center;justify-content:space-between;margin-bottom:8px;">
          <strong>WebAdapterTools</strong>
          <span style="font-size:11px;color:#4b5563;">Prepare</span>
        </div>
        <div style="color:#374151;margin-bottom:10px;">${state.message}</div>
        <div style="display:flex;gap:8px;justify-content:flex-end;">
          ${button(`${controlId}_prepare`, 'Capture baseline', true)}
        </div>`;
    } else if (state.phase === 'ready') {
      body = `
        <div style="display:flex;gap:8px;align-items:center;justify-content:space-between;margin-bottom:8px;">
          <strong>Action ${state.actionIndex}</strong>
          <span style="font-size:11px;color:#4b5563;">Ready</span>
        </div>
        <label style="display:block;margin-bottom:8px;color:#374151;">Action label
          <input id="${controlId}_label" value="${label.replace(/"/g, '&quot;')}" placeholder="optional" style="
            width:100%;box-sizing:border-box;margin-top:4px;border:1px solid #9ca3af;border-radius:6px;padding:6px;
          ">
        </label>
        <div style="display:flex;gap:8px;justify-content:flex-end;">
          ${button(`${controlId}_start`, 'Start recording', true)}
        </div>`;
    } else if (state.phase === 'recording') {
      body = `
        <div style="display:flex;gap:8px;align-items:center;justify-content:space-between;margin-bottom:8px;">
          <strong>Action ${state.actionIndex}</strong>
          <span style="font-size:11px;color:#991b1b;">Recording</span>
        </div>
        <div style="color:#374151;margin-bottom:8px;">Perform this action, wait for the result, then finish it here.</div>
        <label style="display:block;margin-bottom:8px;color:#374151;">Action label
          <input id="${controlId}_label" value="${label.replace(/"/g, '&quot;')}" placeholder="optional" style="
            width:100%;box-sizing:border-box;margin-top:4px;border:1px solid #9ca3af;border-radius:6px;padding:6px;
          ">
        </label>
        <div style="display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap;">
          ${button(`${controlId}_finish_next`, 'Finish action')}
          ${button(`${controlId}_finish_all`, 'Finish capture', true)}
        </div>`;
    } else {
      body = `
        <div style="display:flex;gap:8px;align-items:center;justify-content:space-between;margin-bottom:8px;">
          <strong>WebAdapterTools</strong>
          <span style="font-size:11px;color:#166534;">Done</span>
        </div>
        <div style="color:#374151;">Capture is complete. You can return to the terminal.</div>`;
    }
    root.innerHTML = body;

    document.getElementById(`${controlId}_prepare`)?.addEventListener('click', () => emit('prepare-ready'));
    document.getElementById(`${controlId}_start`)?.addEventListener('click', () => emit('start-action'));
    document.getElementById(`${controlId}_finish_next`)?.addEventListener('click', () => emit('finish-action'));
    document.getElementById(`${controlId}_finish_all`)?.addEventListener('click', () => emit('finish-capture'));
  }

  window.__watSetControlState = nextState => {
    window.__watControlState = { ...window.__watControlState, ...nextState };
    render();
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', render, { once: true });
  } else {
    render();
  }
}

export async function installBrowserControls(page) {
  const signals = [];
  const waiters = [];
  let state = {
    phase: 'prepare',
    actionIndex: 1,
    label: '',
    message: 'Prepare the page, then capture the baseline.'
  };

  function receive(signal) {
    const normalized = {
      type: signal?.type || 'unknown',
      actionIndex: Number(signal?.actionIndex || state.actionIndex || 1),
      label: String(signal?.label || '').slice(0, 80),
      atMs: Number(signal?.atMs || 0),
      url: signal?.url || ''
    };
    signals.push(normalized);
    for (let i = 0; i < waiters.length; i++) {
      const waiter = waiters[i];
      if (waiter.types.includes(normalized.type)) {
        waiters.splice(i, 1);
        waiter.resolve(normalized);
        return;
      }
    }
  }

  await page.exposeBinding(CONTROL_BINDING, async (_source, signal) => receive(signal)).catch(error => {
    if (!/already registered|has been already registered/i.test(error.message)) throw error;
  });
  const installerConfig = { bindingName: CONTROL_BINDING, controlId: CONTROL_ID };
  await page.addInitScript(controlInstaller, installerConfig);

  async function applyState() {
    await page.evaluate((nextState) => {
      window.__watSetControlState?.(nextState);
    }, state).catch(() => {});
  }

  page.on('domcontentloaded', () => {
    applyState().catch(() => {});
  });

  await page.evaluate(controlInstaller, installerConfig).catch(() => {});
  await applyState();

  function waitFor(types) {
    const accepted = Array.isArray(types) ? types : [types];
    const existingIndex = signals.findIndex(signal => accepted.includes(signal.type));
    if (existingIndex >= 0) {
      const [signal] = signals.splice(existingIndex, 1);
      return Promise.resolve(signal);
    }
    return new Promise(resolve => {
      let done = false;
      const finish = signal => {
        if (done) return;
        done = true;
        resolve(signal);
      };
      const poll = async () => {
        if (done) return;
        const signal = await page.evaluate((wantedTypes) => {
          const queue = window.__watControlSignals || [];
          const index = queue.findIndex(item => wantedTypes.includes(item?.type));
          if (index < 0) return null;
          const [item] = queue.splice(index, 1);
          return item || null;
        }, accepted).catch(() => null);
        if (signal) {
          finish(signal);
          return;
        }
        setTimeout(poll, 200);
      };
      waiters.push({ types: accepted, resolve: finish });
      poll();
    });
  }

  return {
    async setState(nextState) {
      state = { ...state, ...nextState };
      await applyState();
    },
    waitFor,
    getState() {
      return { ...state };
    }
  };
}
