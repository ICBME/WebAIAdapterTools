function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderRecommendationGroup(title, items) {
  if (!items?.length) return `<section><h2>${escapeHtml(title)}</h2><p class="muted">No candidates.</p></section>`;
  return `
    <section>
      <h2>${escapeHtml(title)}</h2>
      <div class="grid">
        ${items.map(item => `
          <article class="card candidate" data-type="${escapeHtml(item.type)}" data-score="${item.score}">
            <div class="row"><strong>${escapeHtml(item.elementId)}</strong><span class="score">${item.score}</span></div>
            <p>${escapeHtml(item.element.ariaLabel || item.element.placeholder || item.element.text || item.element.labelText || item.element.tag)}</p>
            <p class="muted">${escapeHtml(item.reasons.join(' | '))}</p>
            <ol>${item.locatorCandidates.map(loc => `<li><code>${escapeHtml(loc.value)}</code><br><span class="muted">${escapeHtml(loc.reason)}</span></li>`).join('')}</ol>
          </article>
        `).join('')}
      </div>
    </section>
  `;
}

function renderElementTable(elements) {
  return `
    <section>
      <h2>All Elements</h2>
      <table>
        <thead>
          <tr>
            <th>ID</th><th>Categories</th><th>Tag</th><th>Role</th><th>Text / Label</th><th>Locator path</th><th>Visible</th>
          </tr>
        </thead>
        <tbody>
          ${elements.map(el => `
            <tr class="element-row" data-category="${escapeHtml(el.categories.join(' '))}">
              <td>${escapeHtml(el.idRef)}</td>
              <td>${escapeHtml(el.categories.join(', '))}</td>
              <td>${escapeHtml(el.tag)}${el.type ? `[${escapeHtml(el.type)}]` : ''}</td>
              <td>${escapeHtml(el.role)}</td>
              <td>${escapeHtml(el.ariaLabel || el.placeholder || el.labelText || el.text)}</td>
              <td><code>${escapeHtml(el.cssPath)}</code></td>
              <td>${el.visible ? 'yes' : 'no'}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </section>
  `;
}

function renderNetwork(network) {
  const requests = network?.requests || [];
  return `
    <section>
      <h2>Network Summary</h2>
      <p class="muted">Only URL origin/path/query keys, method, resource type, status, and failures are recorded. Headers and bodies are not captured.</p>
      <pre>${escapeHtml(JSON.stringify(network?.summary || {}, null, 2))}</pre>
      <table>
        <thead><tr><th>Method</th><th>URL</th><th>Type</th><th>Status</th><th>Failure</th></tr></thead>
        <tbody>
          ${requests.slice(0, 200).map(req => `
            <tr>
              <td>${escapeHtml(req.method)}</td>
              <td>${escapeHtml(req.url?.display || '')}</td>
              <td>${escapeHtml(req.resourceType)}</td>
              <td>${escapeHtml(req.status ?? '')}</td>
              <td>${escapeHtml(req.failure || '')}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </section>
  `;
}

function renderActionCapture(actionCapture) {
  if (!actionCapture) return '';
  const events = actionCapture.events || [];
  return `
    <section>
      <h2>Manual Action Capture</h2>
      <p class="muted">The user manually performed the target action. This tool recorded safe DOM event metadata, before/after snapshots, and network metadata.</p>
      <h3>Action Events</h3>
      ${events.length ? `
        <table>
          <thead><tr><th>#</th><th>Type</th><th>Target</th><th>Input / Files / Key</th><th>URL</th></tr></thead>
          <tbody>
            ${events.slice(0, 120).map(event => `
              <tr>
                <td>${escapeHtml(event.seq)}</td>
                <td>${escapeHtml(event.type)}</td>
                <td>${escapeHtml(event.target?.ariaLabel || event.target?.placeholder || event.target?.text || event.target?.cssPath || event.target?.tag || '')}</td>
                <td><code>${escapeHtml(JSON.stringify(event.input || event.files || event.key || event.submitter || {}, null, 0))}</code></td>
                <td>${escapeHtml(event.frameUrl?.display || '')}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      ` : '<p class="muted">No DOM action events were recorded.</p>'}
      <h3>Before / After Diff</h3>
      <pre>${escapeHtml(JSON.stringify(actionCapture.diff || {}, null, 2))}</pre>
      ${renderNetwork(actionCapture.network)}
    </section>
  `;
}

export function renderHtmlReport(profile) {
  const activeElements = profile.actionCapture?.after?.elements || profile.elements;
  const activeRecommendations = profile.actionCapture?.after?.recommendations || profile.recommendations;
  const allElements = activeElements?.all || [];
  const initialUrl = profile.capture?.initialUrl?.display || profile.capture?.initialUrl || '';
  const finalUrl = profile.capture?.finalUrl?.display || profile.capture?.finalUrl || '';
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>WebAdapterTools Profile - ${escapeHtml(profile.page?.title || profile.capture?.finalUrl || '')}</title>
  <style>
    body { font-family: Inter, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; margin: 0; color: #18202a; background: #f6f7f9; }
    header { background: #111827; color: white; padding: 20px 28px; }
    main { padding: 20px 28px 40px; }
    h1, h2 { margin: 0 0 12px; }
    section { margin: 20px 0; }
    code, pre { background: #eef1f5; border-radius: 4px; }
    code { padding: 2px 4px; }
    pre { padding: 12px; overflow: auto; }
    table { width: 100%; border-collapse: collapse; background: white; border: 1px solid #d9dee7; }
    th, td { text-align: left; vertical-align: top; border-bottom: 1px solid #e5e9f0; padding: 8px 10px; font-size: 13px; }
    th { background: #f0f3f7; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 12px; }
    .card { background: white; border: 1px solid #d9dee7; border-radius: 8px; padding: 12px; }
    .row { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
    .score { display: inline-flex; align-items: center; justify-content: center; min-width: 36px; height: 26px; border-radius: 13px; background: #0f766e; color: white; font-weight: 700; }
    .muted { color: #5f6b7a; font-size: 13px; }
    .toolbar { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; margin: 16px 0; }
    .toolbar label { font-size: 13px; color: #374151; }
    input, select { padding: 6px 8px; border: 1px solid #c7ced8; border-radius: 6px; }
    .hidden { display: none; }
  </style>
</head>
<body>
  <header>
    <h1>WebAdapterTools Page Profile</h1>
    <div>${escapeHtml(initialUrl)} → ${escapeHtml(finalUrl)}</div>
    <div class="muted">${escapeHtml(profile.capture?.capturedAt)} · ${escapeHtml(profile.page?.title)}</div>
  </header>
  <main>
    <section class="card">
      <h2>Safety Notes</h2>
      <p>This profiler does not submit forms, upload files, automate login, or store response bodies. Login, authorization, captcha, and verification controls are deliberately downgraded in recommendations.</p>
    </section>
    <div class="toolbar">
      <label>Filter category <select id="categoryFilter"><option value="">All</option><option>input</option><option>button</option><option>fileInput</option><option>link</option><option>form</option><option>output</option></select></label>
      <label>Minimum score <input id="scoreFilter" type="number" min="0" max="100" value="0"></label>
    </div>
    ${renderRecommendationGroup('Recommended Inputs', activeRecommendations?.inputs)}
    ${renderRecommendationGroup('Recommended Upload Entrances', activeRecommendations?.uploads)}
    ${renderRecommendationGroup('Recommended Submit Buttons', activeRecommendations?.submits)}
    ${renderRecommendationGroup('Recommended Output Containers', activeRecommendations?.outputs)}
    ${renderActionCapture(profile.actionCapture)}
    ${renderElementTable(allElements)}
    ${renderNetwork(profile.network)}
  </main>
  <script>
    const categoryFilter = document.getElementById('categoryFilter');
    const scoreFilter = document.getElementById('scoreFilter');
    function applyFilters() {
      const category = categoryFilter.value;
      const minScore = Number(scoreFilter.value || 0);
      document.querySelectorAll('.candidate').forEach(card => {
        const score = Number(card.dataset.score || 0);
        card.classList.toggle('hidden', score < minScore || (category && card.dataset.type !== category));
      });
      document.querySelectorAll('.element-row').forEach(row => {
        row.classList.toggle('hidden', Boolean(category) && !row.dataset.category.split(' ').includes(category));
      });
    }
    categoryFilter.addEventListener('change', applyFilters);
    scoreFilter.addEventListener('input', applyFilters);
  </script>
</body>
</html>`;
}
