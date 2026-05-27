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
const systemStatus = document.getElementById('systemStatus');

function renderPreview(text) {
  const parts = text
    .split(/[\n,;\t\s]+/)
    .map((item) => item.trim())
    .filter(Boolean);
  const unique = [...new Set(parts)];
  const duplicates = parts.length - unique.length;

  parsePreview.innerHTML = `<strong>${unique.length}</strong> parsed · ${duplicates} duplicate${duplicates === 1 ? '' : 's'}`;

  return unique;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  })[ch]);
}

function renderResultItems(items) {
  if (!Array.isArray(items) || items.length === 0) {
    return '<div class="empty">No results.</div>';
  }

  return items.map((item) => {
    const status = String(item.status || '').toLowerCase();
    const cls = status === 'ok' || status === 'success' ? 'ok' : (status === 'error' || status === 'failed' ? 'err' : '');
    return `
    <div class="result">
      <span class="result-url" title="${escapeHtml(item.url)}">${escapeHtml(item.url)}</span>
      <span class="badge ${cls}">${escapeHtml(item.status)}</span>
    </div>`;
  }).join('');
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
  poolSummary.textContent = `${running} active · ${provisioning} provisioning · ${terminating} terminating`;
}

function setRunningState(isRunning) {
  runBtn.disabled = isRunning;
  runBtn.textContent = isRunning ? 'Running…' : 'Run';
  systemStatus.textContent = isRunning ? 'Running' : 'Idle';
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
  results.innerHTML = '<div class="empty">Submitting…</div>';

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
    results.innerHTML = `<div class="empty">${escapeHtml(error.message)}</div>`;
    poolState.textContent = 'error';
    poolSummary.textContent = 'Run failed. Check the backend and retry.';
  } finally {
    setRunningState(false);
  }
});
