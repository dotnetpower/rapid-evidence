const urlsEl = document.getElementById('urls');
const minVmEl = document.getElementById('minVm');
const maxVmEl = document.getElementById('maxVm');
const batchSizeEl = document.getElementById('batchSize');
const parsePreview = document.getElementById('parsePreview');
const results = document.getElementById('results');
const runBtn = document.getElementById('runBtn');
const metricReady = document.getElementById('metricReady');
const metricActive = document.getElementById('metricActive');
const metricQueued = document.getElementById('metricQueued');
const poolValue = document.getElementById('poolValue');
const poolState = document.getElementById('poolState');
const poolSummary = document.getElementById('poolSummary');
const systemBadge = document.getElementById('systemBadge');

function renderPreview(text) {
  const parts = text
    .split(/[\n,;\t\s]+/)
    .map((item) => item.trim())
    .filter(Boolean);
  const unique = [...new Set(parts)];
  const duplicates = parts.length - unique.length;

  parsePreview.innerHTML = '';
  parsePreview.insertAdjacentHTML('beforeend', `<div class="chip">parsed ${unique.length}</div>`);
  parsePreview.insertAdjacentHTML('beforeend', `<div class="chip">duplicates ${duplicates}</div>`);
  if (unique.length > 0) {
    parsePreview.insertAdjacentHTML('beforeend', `<div class="chip">sample ${unique.slice(0, 3).join(' | ')}</div>`);
  } else {
    parsePreview.insertAdjacentHTML('beforeend', `<div class="chip">sample none</div>`);
  }

  return unique;
}

function renderResultItems(items) {
  if (!Array.isArray(items) || items.length === 0) {
    return '<div class="empty-state">No results yet.</div>';
  }

  return items.map((item) => `
    <div class="result-item">
      <div>
        <strong>${item.url}</strong>
        <span class="result-subline">${item.status}</span>
      </div>
      <span class="status-badge">${item.status}</span>
    </div>
  `).join('');
}

function updatePoolUI(data) {
  const running = Number(data.pool?.running || 0);
  const idle = Number(data.pool?.idle || 0);
  const provisioning = Number(data.pool?.provisioning || 0);
  const terminating = Number(data.pool?.terminating || 0);

  metricReady.textContent = String(idle + running);
  metricActive.textContent = String(running);
  metricQueued.textContent = String(Math.max(0, data.valid_count - running));
  poolValue.textContent = `${running} / ${idle + running + provisioning}`;
  poolState.textContent = running > 0 ? 'active' : 'standby';
  poolSummary.textContent = `${running} worker${running === 1 ? '' : 's'} active, ${provisioning} provisioning, ${terminating} terminating.`;
}

function setRunningState(isRunning) {
  runBtn.disabled = isRunning;
  runBtn.textContent = isRunning ? 'Running…' : 'Run batch';
  systemBadge.textContent = isRunning ? 'running' : 'idle';
}

urlsEl.addEventListener('input', () => renderPreview(urlsEl.value));
renderPreview(urlsEl.value);

runBtn.addEventListener('click', async () => {
  const urls = renderPreview(urlsEl.value);
  const payload = {
    urls,
    min_vm: Number(minVmEl.value),
    max_vm: Number(maxVmEl.value),
    batch_size: Number(batchSizeEl.value),
    source: 'generic-http'
  };

  setRunningState(true);
  results.innerHTML = '<div class="empty-state">Submitting run…</div>';

  try {
    const response = await fetch('/run', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      throw new Error(`Request failed with status ${response.status}`);
    }

    const data = await response.json();
    updatePoolUI(data);
    results.innerHTML = renderResultItems(data.results);
  } catch (error) {
    results.innerHTML = `<div class="empty-state">${error.message}</div>`;
    poolState.textContent = 'error';
    poolSummary.textContent = 'The run could not complete. Check the backend status and try again.';
  } finally {
    setRunningState(false);
  }
});
