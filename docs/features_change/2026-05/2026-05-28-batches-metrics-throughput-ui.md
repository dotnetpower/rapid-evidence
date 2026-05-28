# Batch + metrics aggregation API and Throughput dashboard

## Why

The pool manager from 2026-05-28 exposes per-VM state but the dashboard
described in the v2-1 mockup needs a workload-aware view: how many requests
are queued, how fast the pool absorbs that backlog, and per-batch progress
with an ETA. Those concepts did not exist server-side, so the React
frontend could not be built against real data.

This change introduces a thin, in-process batch tracker and a time-series
collector that together let the existing FastAPI app drive the new
**Throughput** page.

## What changed — backend

### `rapid_evidence.batches`
- `BatchStatus` enum (`queued / running / paused / done / cancelled / failed`).
- `BatchRecord` (mutable) — owns the `FetchRequest` list, counters, an
  `asyncio.Event` for cancellation, and a 60-second rolling deque of
  completion timestamps used to derive per-batch throughput and ETA.
- `BatchProgress` (immutable snapshot) — what the API layer serialises:
  totals, percent, workers active/target, throughput, ETA, timestamps,
  error, metadata.
- `BatchExecutor` — runs one `BatchRecord` as an asyncio task. Worker
  concurrency is bounded by an `asyncio.Semaphore(workers_target)`,
  sync `source.fetch` / `sink.write` calls are dispatched via
  `asyncio.to_thread`, and every request honours a per-request timeout.
  Cancellation is cooperative: new units short-circuit when the cancel
  event is set, in-flight units finish or time out.
- `BatchRegistry` — submits batches, starts the executor task, exposes
  list/get/cancel, and aggregates **backlog** (sum of pending across
  running/queued/paused batches), **aggregate throughput** (rolling 60 s
  global window across all batches), and **drain ETA** (`backlog / rate`).
  `stop_all()` is called from `lifespan` so background tasks shut down
  cleanly.

### `rapid_evidence.metrics`
- `MetricSample` (frozen) — `timestamp`, monotonic, `backlog`,
  `throughput_per_second`, `active_vms`, per-state VM counts,
  `active_batches`.
- `MetricsCollector` — bounded ring buffer (deque with `maxlen` derived
  from `retention_seconds / sample_interval_seconds + 2`), async sampler
  loop, `start()` takes an initial sample so the dashboard has data on
  first paint, `stop()` cancels the task, snapshot exceptions are logged
  and the loop continues. `query(window_seconds)` filters by monotonic
  cutoff; `latest()` returns the most recent sample.
- `build_metric_sample(...)` helper assembles a sample from live pool
  counters and registry aggregates.

### `rapid_evidence.api`
- New imports for `batches` / `metrics` packages, `SpotNodeState`,
  `estimate_spot_capacity`. Existing `/run`, `/pool/*` routes are
  unchanged.
- `default_source_client_factory(source)` and `default_result_sink()`
  are module-level so tests can monkeypatch them.
- `build_batch_registry(source_client_factory=None, sink_factory=None,
  default_workers=None)` resolves the factories through module globals at
  *call time* — this is required so test monkeypatches actually take
  effect (early `=default_…` parameter defaults captured the unpatched
  reference).
- `lifespan` now also starts a `BatchRegistry` and a `MetricsCollector`
  (whose snapshot callback aggregates live pool counters + registry
  state), and tears both down on shutdown.
- New routes:
  | Method | Path | Purpose |
  | --- | --- | --- |
  | `POST` | `/batches` | submit a batch (`source`, `targets[]`, optional `workers`, `headers`, `metadata`) — returns `BatchProgress` |
  | `GET`  | `/batches` | list batches (newest first) with live progress |
  | `GET`  | `/batches/{id}` | single batch progress |
  | `POST` | `/batches/{id}/cancel` | cooperative cancel; returns final progress |
  | `GET`  | `/metrics/timeseries?window_seconds=…` | ring-buffer samples for charts |
  | `GET`  | `/dashboard/summary` | aggregated KPI payload (backlog, throughput, drain ETA, pool counters, scale target, latest sample) |
- `/dashboard/summary` derives `scale_target` from
  `estimate_spot_capacity(config, backlog, ready_nodes, active_nodes, {})`
  so the UI can render scale-up progress even before the pool is asked to
  resize.

## What changed — environment / deps

- `pyproject.toml`:
  - `[tool.pytest.ini_options]` adds `asyncio_mode = "auto"` and
    `asyncio_default_fixture_loop_scope = "function"`.
  - `[dependency-groups].dev` adds `pytest-asyncio>=1.4.0`.
- New env vars (all optional):
  | Variable | Default | Purpose |
  | --- | --- | --- |
  | `RAPID_EVIDENCE_BATCH_WORKERS` | `4` | Default per-batch worker concurrency |
  | `RAPID_EVIDENCE_METRICS_INTERVAL_SECONDS` | `5.0` | Sampler interval |
  | `RAPID_EVIDENCE_METRICS_RETENTION_SECONDS` | `3600.0` | Ring-buffer window |
  | `RAPID_EVIDENCE_FETCH_TIMEOUT_SECONDS` | `30.0` | Per-request HTTP timeout used by the default source factory |
  | `RAPID_EVIDENCE_RESULT_DIR` | `.rapid-evidence` | Filesystem sink directory |

## What changed — frontend (`web/`)

The repo's previous single-file `web/{index.html, app.js}` were moved to
`web/legacy/` and the directory rebooted as a Vite + React + TypeScript app.

- Toolchain: Vite 6, React 19, React Router 6, TanStack Query 5,
  Recharts 2, Vitest 3 (+ Testing Library, jsdom).
- `vite.config.ts` proxies `/health /pool /batches /metrics /dashboard
  /run` to `http://localhost:8000` for local dev.
- `src/styles/{tokens.css,app.css}` — VS Code Dark Modern palette,
  ported verbatim from the v2-1 mockup.
- `src/lib/api.ts` — typed fetch client (`DashboardSummary`,
  `BatchProgress`, `MetricsTimeseries`, `MetricSample`, `ApiError`,
  `api.*` callers).
- `src/lib/format.ts` — `formatNumber / formatRate / formatDuration /
  formatPercent / timeAgo` (covered by Vitest).
- `src/components/`
  - `AppShell` — title bar, left navigation, status bar; polls
    `/dashboard/summary` every 2 s and surfaces backlog / throughput /
    drain ETA in the status bar.
  - `KpiCard` — top 4 KPI tiles.
  - `ThroughputChart` — Recharts dual-axis chart (backlog area + active
    VM line + throughput line) backed by `/metrics/timeseries`.
  - `PoolPanel` — ready / running / provisioning / draining bars
    against the live scale target.
  - `BatchesTable` — per-batch progress, throughput, ETA, workers, state,
    cancel button (TanStack Query mutation).
  - `NewBatchDialog` — submit a batch via `POST /batches`.
- `src/pages/ThroughputPage.tsx` composes the page; `src/main.tsx`
  wires QueryClient + Router.
- Vitest setup file imports `@testing-library/jest-dom/vitest` for matchers;
  `format.test.ts` covers the formatter helpers.

## Tests

- `tests/test_batches.py` — submit/run-to-completion (counters, percent,
  ETA, sink writes), mixed success/failure, cooperative cancel during
  flight, aggregate backlog/throughput/drain ETA across multiple batches,
  drain ETA `None` when throughput is still 0, input validation.
- `tests/test_metrics.py` — `build_metric_sample` aggregation, immediate
  start sample, windowed query, bounded ring buffer (does not grow
  unbounded), constructor validation, sampler survives snapshot exceptions.
- `tests/test_api_batches.py` — end-to-end via `TestClient`:
  create/list/get/cancel batches, 404 / 422 boundaries,
  `/metrics/timeseries` shape, `/dashboard/summary` aggregation.
- `web/src/__tests__/format.test.ts` — number / rate / duration / percent
  formatters.

## Verification

- Backend: `uv run pytest -q` — 40 passed (21 pre-existing + 19 new).
- Frontend: `cd web && npm test` — 4 passed.
- Frontend: `cd web && npm run build` — passes (`tsc -b && vite build`).
- Smoke (manual): `uv run uvicorn rapid_evidence.api:app --port 8765` +
  `curl /health`, `/dashboard/summary`, `POST /batches`, `GET /batches`,
  `/metrics/timeseries?window_seconds=60` — all 200/201, payload shapes
  match the typed client.

## Not in this slice

- Multi-region quota sweep + 24 h scheduler + quota increase request.
- `SpotNode.region` field; the v2-2 (real map) and v2-3 (scaling timeline)
  pages are intentionally deferred — their navigation entries are
  rendered as disabled.
- Cold start latency (`provisioning_started_at` / `ready_at` timestamps
  on `SpotNode`).
