# Code Map

Authoritative inventory of the `rapid_evidence` source tree. Keep this file
in sync with the code in the same change that adds, removes, splits, or
renames a module. See [.github/copilot-instructions.md](../.github/copilot-instructions.md)
for the SRP / hardening rules that govern this layout.

Conventions
- `LOC` = `wc -l` of the file at the time of the last codemap update.
- Files marked **OVER LIMIT** exceed the 300-line ceiling (SRP rule 7) and
  must be split before adding more behaviour.
- Public exports are the names re-exported from `src/rapid_evidence/__init__.py`.

## Package entry point

| File | LOC | Responsibility |
| ---- | --: | -------------- |
| [src/rapid_evidence/__init__.py](../src/rapid_evidence/__init__.py) | 31 | Public API surface. Exports: `FetchRequest`, `FetchResult`, `RequestStatus`, `SourcePolicy`, `SurgeLimits`, `WorkerLease`, `WorkerSpec`, `WorkerStatus`, `SurgeOrchestrator`, `SpotPoolConfig`, `SpotVmScheduler`, `SpotPoolManager`, `InMemorySpotVmProvider`, `AzureCliSpotVmProvider`, `AzureSpotVmConfig`, error types. |
| [src/rapid_evidence/cli.py](../src/rapid_evidence/cli.py) | 101 | `rapidfetch` entry point — argparse dispatcher. |
| [src/rapid_evidence/api.py](../src/rapid_evidence/api.py) | 1059 | **OVER LIMIT.** FastAPI app: lifespan, env config helpers, `RunRequest`/`RunResponse`, `/run`, `/batches/*`, `/dashboard/*`, eviction drain loop, jobs/regions/quota/scaling routes. Hot-poll endpoints (`/events`, `/quota/status`, `/regions/status`) now call lightweight `manager.recent_events / quota_dict / regions_summary` instead of full `snapshot()` (cycle-3 perf). Split candidates: `api/app.py` (lifespan + DI), `api/routes_batches.py`, `api/routes_dashboard.py`, `api/config.py` (`_env_*`, `_build_*`). |

## core/ — shared primitives

| File | LOC | Responsibility |
| ---- | --: | -------------- |
| [src/rapid_evidence/core/errors.py](../src/rapid_evidence/core/errors.py) | 18 | `RapidEvidenceError` + `PolicyViolationError`, `QueueCapacityError`, `ProviderError`, `SourceFetchError`. |
| [src/rapid_evidence/core/ids.py](../src/rapid_evidence/core/ids.py) | 11 | `new_id(prefix)` — URL-safe prefixed short id. |
| [src/rapid_evidence/core/models.py](../src/rapid_evidence/core/models.py) | 129 | Frozen dataclasses: `FetchRequest`, `FetchResult`, `RequestStatus`, `SourcePolicy`, `SurgeLimits`, `WorkerSpec`, `WorkerLease`, `WorkerStatus`. |
| [src/rapid_evidence/core/time.py](../src/rapid_evidence/core/time.py) | 5 | `utc_now_iso()` — RFC 3339 UTC string. |

## policy/ — source policy registry

| File | LOC | Responsibility |
| ---- | --: | -------------- |
| [src/rapid_evidence/policy/policy_store.py](../src/rapid_evidence/policy/policy_store.py) | 20 | `PolicyStore.register / require`; `SourcePolicy.validate_request` enforces required headers, method allowlist, batch cap. |
| [src/rapid_evidence/policy/defaults.py](../src/rapid_evidence/policy/defaults.py) | 21 | `default_policy_store()` — ships the `generic-http` policy used by local pipeline + tests. |

## queue/ — bounded request queue

| File | LOC | Responsibility |
| ---- | --: | -------------- |
| [src/rapid_evidence/queue/memory.py](../src/rapid_evidence/queue/memory.py) | 39 | `MemoryRequestQueue`: `enqueue`, `dequeue_batch`, `requeue_front`, `size`. Caps via `max_queued` → `QueueCapacityError`. Releases dedupe keys on dequeue. |

## sources/ — outbound HTTP

| File | LOC | Responsibility |
| ---- | --: | -------------- |
| [src/rapid_evidence/sources/url_guard.py](../src/rapid_evidence/sources/url_guard.py) | 30 | `validate_public_http_url(url)` (HTTPS + global IP), `GuardedHTTPTransport` (re-validates every redirect). |
| [src/rapid_evidence/sources/generic_http.py](../src/rapid_evidence/sources/generic_http.py) | 77 | `GenericHttpSource`: bounded streaming fetch, retry budget, `Retry-After` parsing (delta seconds OR HTTP date). |

## providers/ — local worker provisioning

| File | LOC | Responsibility |
| ---- | --: | -------------- |
| [src/rapid_evidence/providers/base.py](../src/rapid_evidence/providers/base.py) | 14 | `WorkerProvider` Protocol: `provision_worker`, `terminate_worker`, `status`. |
| [src/rapid_evidence/providers/local.py](../src/rapid_evidence/providers/local.py) | 21 | `LocalWorkerProvider` — in-process worker for `rapidfetch run-local`. |

## orchestrator/ — local surge planner

| File | LOC | Responsibility |
| ---- | --: | -------------- |
| [src/rapid_evidence/orchestrator/scheduler.py](../src/rapid_evidence/orchestrator/scheduler.py) | 77 | `SurgePlan`, `SurgeOrchestrator.run_local_once(...)`. Caps via `SurgeLimits` (workers, runtime, USD). |

## storage/ — result sink

| File | LOC | Responsibility |
| ---- | --: | -------------- |
| [src/rapid_evidence/storage/filesystem.py](../src/rapid_evidence/storage/filesystem.py) | 33 | `FileSystemResultSink`: writes `<dir>/<request_id>.json`, 0700 dir / 0600 file, fsync. |

## audit/ — append-only ledger

| File | LOC | Responsibility |
| ---- | --: | -------------- |
| [src/rapid_evidence/audit/ledger.py](../src/rapid_evidence/audit/ledger.py) | 20 | `JsonlAuditLedger.record(event_type, payload)` — thread-safe, fsync per record, 0700/0600. |

## metrics/ — throughput collector

| File | LOC | Responsibility |
| ---- | --: | -------------- |
| [src/rapid_evidence/metrics/collector.py](../src/rapid_evidence/metrics/collector.py) | 169 | `MetricSample`, `MetricsCollector` (rolling window with `bisect`-based window slice — cycle-3 perf), `build_metric_sample(...)`. |

## batches/ — batch lifecycle

| File | LOC | Responsibility |
| ---- | --: | -------------- |
| [src/rapid_evidence/batches/registry.py](../src/rapid_evidence/batches/registry.py) | 566 | **OVER LIMIT.** Contains `BatchStatus`, `SourceClient` Protocol, `ResultSink` Protocol, `BatchProgress`, `BatchRecord` (now with `history: deque[dict]` FIFO-capped at 256 + `evicted_request_ids`; cycle-3 removed the redundant `del [:overflow]` memcpy by switching to `deque(maxlen)`), `BatchExecutor` (cycle-3 removed dead `asyncio.Lock` around `workers_active` counter — saves ~2 lock ops per dequeued request on the hot path), `BatchRegistry`. Records lifecycle events (`queued`/`started`/`finished`/`cancel_requested`/`evicted`) into `record.history` for the batches detail-page timeline. Split candidates: `batches/models.py` (status + dataclasses), `batches/executor.py` (`BatchExecutor`), `batches/registry.py` (registry only), `batches/protocols.py` (Protocols). |

## spot/ — Azure Spot VM pool

| File | LOC | Responsibility |
| ---- | --: | -------------- |
| [src/rapid_evidence/spot/models.py](../src/rapid_evidence/spot/models.py) | 119 | `SpotPoolConfig`, `SpotPoolStatus`, `SpotNode`, `SpotNodeState`, `SpotReservation`, `SpotCapacityPlan`, `IpDistribution`, `EvictionEvent`, `QuotaSnapshot`, `CleanupReport`, `ObservedSpotTimings`. |
| [src/rapid_evidence/spot/provider.py](../src/rapid_evidence/spot/provider.py) | 24 | `SpotVmProvider` Protocol, `SpotVmDiscoveryProvider`, `SpotAuditSink`. |
| [src/rapid_evidence/spot/sizing.py](../src/rapid_evidence/spot/sizing.py) | 19 | `estimate_spot_capacity(...)` — non-blocking warm-pool plan. |
| [src/rapid_evidence/spot/scheduler.py](../src/rapid_evidence/spot/scheduler.py) | 171 | `SpotVmScheduler` — pure planner over provider snapshots. |
| [src/rapid_evidence/spot/fake.py](../src/rapid_evidence/spot/fake.py) | 70 | `InMemorySpotVmProvider` — deterministic test double. |
| [src/rapid_evidence/spot/manager.py](../src/rapid_evidence/spot/manager.py) | 741 | **OVER LIMIT.** `PoolEvent`, `PoolCounters`, `PoolMetrics`, `SpotPoolManager` (lifecycle, eviction drain, metrics). Cycle-3 perf: `_events` and `_eviction_history` switched to `collections.deque(maxlen)` (O(1) FIFO; no more list `del [:overflow]` memcpy) and three lightweight accessors added — `recent_events(since, limit)`, `quota_dict()`, `regions_summary()` — so high-frequency endpoints no longer pay for the full `snapshot()` aggregation. Also added `_recent_evictions_iter` and a single-pass `_compute_scale_up_target`. Split candidates: `spot/pool_metrics.py`, `spot/pool_lifecycle.py`, `spot/manager.py` (facade). |
| [src/rapid_evidence/spot/azure_cli_provider.py](../src/rapid_evidence/spot/azure_cli_provider.py) | 443 | **OVER LIMIT.** `AzureCliSpotVmProvider`, `AzureSpotVmConfig` — only `az` CLI, no Azure SDK. Split candidates: `spot/azure/config.py`, `spot/azure/cli.py` (subprocess wrapper), `spot/azure/provider.py`. |
| [src/rapid_evidence/spot/regions.py](../src/rapid_evidence/spot/regions.py) | 363 | **OVER LIMIT.** `RegionQuotaProbe`, `MultiRegionQuotaReport`, `DEFAULT_REGIONS`, `probe_regions()` (parallel `az vm list-usage`), `request_quota_increase()`. |

## jobs/ — background-task observability

| File | LOC | Responsibility |
| ---- | --: | -------------- |
| [src/rapid_evidence/jobs/registry.py](../src/rapid_evidence/jobs/registry.py) | ~220 | `BackgroundJob`, `BackgroundJobRegistry` (bounded, thread + asyncio safe, snapshot-on-read with deep copy), `run_tracked()` helper. Backs the dashboard `⚙ jobs N` status segment and the JobsPanel. |

## worker/ — remote agent

| File | LOC | Responsibility |
| ---- | --: | -------------- |
| [src/rapid_evidence/worker/__init__.py](../src/rapid_evidence/worker/__init__.py) | 27 | Package exports for worker module. |
| [src/rapid_evidence/worker/source.py](../src/rapid_evidence/worker/source.py) | 197 | `RemoteWorkerSource` — drives remote agents through a `WorkerTransport`. |
| [src/rapid_evidence/worker/transport.py](../src/rapid_evidence/worker/transport.py) | 268 | `WorkerDispatchError`, `WorkerDispatchPayload`, `WorkerDispatchResult`, `WorkerTransport` Protocol, `InMemoryWorkerTransport`, `HttpWorkerTransport`. Near ceiling — watch for growth. |
| [src/rapid_evidence/worker/agent_runtime.py](../src/rapid_evidence/worker/agent_runtime.py) | 264 | `AGENT_SCRIPT` — embedded stdlib-only on-VM fetch daemon source (no host-side imports). |
| [src/rapid_evidence/worker/agent_install.py](../src/rapid_evidence/worker/agent_install.py) | 114 | Host-side install helpers: `DEFAULT_AGENT_PORT`, `generate_agent_secret`, `AgentInstallSpec` (renders systemd unit + env + cloud-init blocks). |
| [src/rapid_evidence/worker/agent_script.py](../src/rapid_evidence/worker/agent_script.py) | 29 | Backwards-compat facade re-exporting `AGENT_SCRIPT`, `DEFAULT_AGENT_PORT`, `generate_agent_secret`, `AgentInstallSpec`. |

## Tests (current — should mirror source modules)

| File | LOC |
| ---- | --: |
| [tests/test_api.py](../tests/test_api.py) | 73 |
| [tests/test_api_batches.py](../tests/test_api_batches.py) | 174 |
| [tests/test_azure_cli_spot_provider.py](../tests/test_azure_cli_spot_provider.py) | 74 |
| [tests/test_batches.py](../tests/test_batches.py) | 186 |
| [tests/test_cli.py](../tests/test_cli.py) | 34 |
| [tests/test_core_and_queue.py](../tests/test_core_and_queue.py) | 53 |
| [tests/test_metrics.py](../tests/test_metrics.py) | 116 |
| [tests/test_remote_worker.py](../tests/test_remote_worker.py) | 204 |
| [tests/test_sources.py](../tests/test_sources.py) | 53 |
| [tests/test_spot_pool_manager.py](../tests/test_spot_pool_manager.py) | 233 |
| [tests/test_spot_scheduler.py](../tests/test_spot_scheduler.py) | 21 |
| [tests/test_api_events_scaling.py](../tests/test_api_events_scaling.py) | 94 |

Gaps to close on next test refactor:
- `tests/test_core_and_queue.py` mixes two source modules — split into
  `tests/test_core_models.py` + `tests/test_queue_memory.py`.
- `tests/test_sources.py` covers both `url_guard` and `generic_http` — split.
- No dedicated `tests/test_audit_ledger.py`, `tests/test_storage_filesystem.py`,
  `tests/test_policy_store.py`, `tests/test_orchestrator_scheduler.py`,
  `tests/test_spot_models.py`. Add as the corresponding source modules change.

## Web (frontend)

| File | Responsibility |
| ---- | -------------- |
| [web/src/main.tsx](../web/src/main.tsx) | React entrypoint; wraps app in `I18nProvider` + `QueryClientProvider`. Imports `styles/polish.css` for premium UX layer. |
| [web/src/lib/api.ts](../web/src/lib/api.ts) | Backend API client. |
| [web/src/lib/format.ts](../web/src/lib/format.ts) | Display formatters. |
| [web/src/lib/i18n.tsx](../web/src/lib/i18n.tsx) | EN/KO i18n context (`I18nProvider`, `useI18n`, `t(key, vars)`). LocalStorage-backed. |
| [web/src/lib/csv.ts](../web/src/lib/csv.ts) | CSV export helper: `downloadCsv(filename, headers, rows)` + `csvDateStamp()`. Used by every page's export button. **Cycle-2 hardening:** `escapeCell` now neutralises CSV-injection (CWE-1236) — string cells starting with `=`, `+`, `-`, `@`, tab, or CR are prefixed with `'` so spreadsheets render them as literal text. Regression-tested in `__tests__/csv.test.ts`. |
| [web/src/lib/useDocumentTitle.ts](../web/src/lib/useDocumentTitle.ts) | `useDocumentTitle(title, badge?)` — keeps the browser tab title in sync with the active page + a live counter; restores prior title on unmount. |
| [web/src/lib/usePageVisibility.ts](../web/src/lib/usePageVisibility.ts) | `usePageVisibility(): boolean` — true when tab foreground; pages use it to suspend TanStack Query polling on hidden tabs. |
| [web/src/lib/useFavorites.ts](../web/src/lib/useFavorites.ts) | `useFavorites(key)` — bounded localStorage-backed set with `{ set, has, toggle, clear }`. Used by Regions/Quota star columns. |
| [web/src/lib/useToast.ts](../web/src/lib/useToast.ts) | Module-scoped pub/sub toast queue. Exports `pushToast`, `dismissToast`, `dismissAllToasts`, `useToasts`, `useToast()`. Bounded `MAX_TOASTS=5`, auto-dismiss timers cleared on remove. |
| [web/src/lib/useHotkey.ts](../web/src/lib/useHotkey.ts) | `useCtrlOrCmdHotkey({ key, onTrigger, enabled? })` — single-letter Ctrl/Cmd hotkey, skips while typing in inputs. Used by ThroughputPage + BatchesPage for Ctrl+N. |
| [web/src/lib/useKeyboardNav.ts](../web/src/lib/useKeyboardNav.ts) | Global `g<key>` navigation chord + `?` opens shortcut help; mounted once at AppShell. |
| [web/src/components/ToastContainer.tsx](../web/src/components/ToastContainer.tsx) | Renders the active toast queue as an ARIA live region; mounted once at AppShell. |
| [web/src/components/Sparkline.tsx](../web/src/components/Sparkline.tsx) | Tiny inline SVG sparkline. Used by `KpiCard` to surface 5-min trend. |
| [web/src/components/ShortcutHelp.tsx](../web/src/components/ShortcutHelp.tsx) | Modal that lists all global keyboard shortcuts; opened by `?` and the `⌨ ?` button in the status bar. |
| [web/src/components/AppShell.tsx](../web/src/components/AppShell.tsx) | App shell layout, titlebar with EN/한 language toggle. |
| [web/src/components/KpiCard.tsx](../web/src/components/KpiCard.tsx) | KPI card. Optional `sparkline`, `onClick`, `clickHint` props for drill-through. |
| [web/src/components/PoolPanel.tsx](../web/src/components/PoolPanel.tsx) | Spot pool panel — counters, Spot Nodes table, Recent Evictions list. |
| [web/src/components/BatchesTable.tsx](../web/src/components/BatchesTable.tsx) | Batches table — per-batch node count + eviction glyph + inline search + multi-select bulk-cancel + CSV export. |
| [web/src/components/BatchesTableRow.tsx](../web/src/components/BatchesTableRow.tsx) | Single `<tr>` for `BatchesTable`. Pure presentation; receives selection + cancel hooks via props. Exports `isCancellableBatch(b)`. Split out so the parent stays under the 300-line SRP ceiling. |
| [web/src/components/batches/BatchFilterBar.tsx](../web/src/components/batches/BatchFilterBar.tsx) | Filter (all/active/terminal, with optional counts) + sort (newest/rate/evictions) bar for `/batches`. Optional search input + CSV export hook. |
| [web/src/components/batches/BatchListTable.tsx](../web/src/components/batches/BatchListTable.tsx) | Full-page batches table shell (header + row mapping). Cycle-3 perf: extracted per-row rendering into `BatchListRow` so the 2 s `dashboard-summary` poll no longer reconciles every cell on every tick. |
| [web/src/components/batches/BatchListRow.tsx](../web/src/components/batches/BatchListRow.tsx) | `React.memo` wrapper around one batches table row + private `meterColor` / `nodeCount` / `evictionCount` helpers. Receives a stable `onSelect` callback from `BatchesPage` so memoization actually prevents re-renders. |
| [web/src/components/batches/BatchDetailDrawer.tsx](../web/src/components/batches/BatchDetailDrawer.tsx) | Right-slide drawer: summary KPIs, per-node dispatch, eviction impact, timeline, cancel. |
| [web/src/components/batches/BatchTimelineList.tsx](../web/src/components/batches/BatchTimelineList.tsx) | Reverse-chrono timeline list (consumes `GET /batches/{id}/timeline`). |
| [web/src/components/audit/EventFilterBar.tsx](../web/src/components/audit/EventFilterBar.tsx) | Chip-style multi-select filter over the unique `event_type`s in the audit ring buffer. Optional per-type counts + total badge. |
| [web/src/components/audit/EventRow.tsx](../web/src/components/audit/EventRow.tsx) | Audit row: relative + absolute timestamp, colour-coded type pill, on-demand payload toggle, copy-payload button. |
| [web/src/components/scaling/SwimlaneChart.tsx](../web/src/components/scaling/SwimlaneChart.tsx) | v3-2 "Tide Chart" SVG renderer: floor/ceiling bands, active-VMs area, scheduler-intent dashed target line, event glyphs (▲ scale_up, ▼ scale_down, ● eviction, ◇ replaced, ○ provisioned), now cursor. Recharts-free. |
| [web/src/components/scaling/swimlanePaths.ts](../web/src/components/scaling/swimlanePaths.ts) | Pure geometry helpers for the tide chart: `buildTidePlan(samples, events, config, scaleTarget)` returns SVG path strings, axis ticks, event-marker x/y positions. React-free. |
| [web/src/components/scaling/SnapshotRibbons.tsx](../web/src/components/scaling/SnapshotRibbons.tsx) | "Current snapshot · normalized to max" bars (ready/busy/prov/drain + total active) with `min_ready` / `target` / `max_nodes` tick marks. Skips when pool config absent. |
| [web/src/components/scaling/EventMarkerList.tsx](../web/src/components/scaling/EventMarkerList.tsx) | v3-2 "Decision tape": newest-first scale-event log, HH:MM:SS clock + coloured pill + translated "what" + reason-code-aware "why" with `<code>` tokens. |
| [web/src/components/regions/RegionCard.tsx](../web/src/components/regions/RegionCard.tsx) | Region card (clickable, summary metrics) for the `/regions` cards view. |
| [web/src/components/regions/RegionsMap.tsx](../web/src/components/regions/RegionsMap.tsx) | World map (react-leaflet) for `/regions`, marker colour by status, tooltip with nodes / quota / evictions. |
| [web/src/components/regions/regionGeo.ts](../web/src/components/regions/regionGeo.ts) | Static lat/lon catalogue of Azure public regions used by `RegionsMap`. |
| [web/src/components/regions/RegionQuotaTable.tsx](../web/src/components/regions/RegionQuotaTable.tsx) | Per-region quota table (used/limit/headroom + status pill with icon prefix). Optional favorites column. Shared by `/regions` and `/quota`. |
| [web/src/components/regions/regionFilter.ts](../web/src/components/regions/regionFilter.ts) | Pure filter/sort helpers: `filterRegions`, `filterProbes`, `sortProbes`, `compareProbes`, `REGION_SORT_KEYS`, `RegionSortKey`. Promotes favorites to top in stable order. |
| [web/src/components/regions/RegionsToolbar.tsx](../web/src/components/regions/RegionsToolbar.tsx) | Search input + sort dropdown + CSV button + match-count badge. Shared by `/regions` and `/quota`. |
| [web/src/components/regions/RegionDetailPanel.tsx](../web/src/components/regions/RegionDetailPanel.tsx) | Right-hand panel for the selected region: error banner + nodes table. Split out of `RegionsPage` to keep it under the 300-line ceiling. |
| [web/src/components/regions/probeBundle.ts](../web/src/components/regions/probeBundle.ts) | `extractProbeBundle(jobs)` — picks the latest succeeded `azure-region-quota-scan` job and returns probes + subscription totals + last-scan timestamp. Shared by `/regions` and `/quota`. |
| [web/src/components/jobs/JobsPanel.tsx](../web/src/components/jobs/JobsPanel.tsx) | Background-jobs panel for the `/quota` page (scan-now button + recent jobs list). |
| [web/src/lib/useNowTick.ts](../web/src/lib/useNowTick.ts) | `useNowTick(intervalMs)` hook — refreshes `Date.now()`-derived UI (relative timestamps) on a steady cadence even when no query refetched. **Cycle-2 hardening:** shared module-scoped pub/sub — one `setInterval` per distinct interval value across all callers (was previously N timers for N callers, which thrashed a 500-row audit tail). |
| [web/src/components/NewBatchDialog.tsx](../web/src/components/NewBatchDialog.tsx) | New batch dialog. |
| [web/src/components/ThroughputChart.tsx](../web/src/components/ThroughputChart.tsx) | Throughput chart. |
| [web/src/pages/ThroughputPage.tsx](../web/src/pages/ThroughputPage.tsx) | Throughput page route. KPI cards with sparklines + click-drill, Ctrl+N opens dialog, tab-visibility-gated polling, doc title with backlog badge. |
| [web/src/pages/BatchesPage.tsx](../web/src/pages/BatchesPage.tsx) | Batches page route — filter/sort bar with counts, search, CSV export, URL-persistent `?filter`, Ctrl+N, doc-title with active count, URL-driven `/batches/:batchId` detail drawer. |
| [web/src/pages/AuditPage.tsx](../web/src/pages/AuditPage.tsx) | Audit page route. Tails `GET /events` via incremental `since=` cursor; bounded 500-event buffer with fingerprint dedupe; pause/resume tail, search, sort toggle, CSV export, per-type counts, doc-title with buffered count. |
| [web/src/pages/ScalingTimelinePage.tsx](../web/src/pages/ScalingTimelinePage.tsx) | Scaling timeline page route. Reads `GET /scaling/timeline` + `GET /dashboard/summary`; URL-persistent `?window` (15m/60m/6h), event-type filter chips with counts, CSV export, tab-visibility polling, doc-title with event count. |
| [web/src/pages/QuotaPage.tsx](../web/src/pages/QuotaPage.tsx) | Quota page route — per-region quota meters + search/sort/favorites/CSV toolbar + JobsPanel. Doc-title surfaces zero-headroom count. |
| [web/src/pages/RegionsPage.tsx](../web/src/pages/RegionsPage.tsx) | Regions page route — `map ↔ cards` toggle + search/sort/favorites/CSV toolbar + RegionDetailPanel. Lazy-loaded via `Suspense` to keep leaflet out of the main bundle. |
| [web/src/test/setup.ts](../web/src/test/setup.ts) | Vitest setup hook. |
| [web/src/styles/audit.css](../web/src/styles/audit.css) | Page-scoped styles for the Audit page (imported by `AuditPage.tsx`). Kept separate from `app.css` to avoid races with other sessions editing the shared stylesheet. |
| [web/src/styles/scaling.css](../web/src/styles/scaling.css) | Page-scoped styles for the Scaling Timeline page (imported by `ScalingTimelinePage.tsx`). |
| [web/src/styles/quota-regions.css](../web/src/styles/quota-regions.css) | Page-scoped styles for the Quota + Regions pages, including world-map and legend styling. |
| [web/src/styles/polish.css](../web/src/styles/polish.css) | Cross-cutting premium UX layer: toast/modal/sparkline/search-input/bulk-bar/favorite-button/region-legend/headroom-bar/audit-tail-bar styles + `.row-selected` highlight. Imported once by `main.tsx`. |
| [web/src/__tests__/format.test.ts](../web/src/__tests__/format.test.ts) | Vitest suite for `lib/format`. |
| [web/src/__tests__/csv.test.ts](../web/src/__tests__/csv.test.ts) | Vitest suite for `lib/csv` (12 tests) — RFC-4180 quoting, CRLF line endings, null/undefined handling, and the **CSV-injection regression** (one per `=`/`+`/`-`/`@`/tab/CR trigger, plus benign + numeric round-trip) from cycle-2 hardening. |
| [web/src/components/scaling/__tests__/swimlanePaths.test.ts](../web/src/components/scaling/__tests__/swimlanePaths.test.ts) | Vitest suite for `swimlanePaths` (17 tests) — `activeFor` (active_vms priority + per-state-sum fallback + empty payload), `targetFor` (incl. div-by-zero guard), `buildTidePlan` (drawable/empty, ceiling/floor in-chart, now-cursor, marker clamp, tick counts, no-config target path, **live scaleTarget anchoring**, **out-of-range scaleTarget clamping**). |

## Scripts & docs

| Path | Responsibility |
| ---- | -------------- |
| [scripts/spot_vm_ip_probe.py](../scripts/spot_vm_ip_probe.py) | Operational probe to enumerate outbound IPs across spot VMs. |
| [docs/features_change/](../docs/features_change/) | Per-change feature notes, organised `YYYY-MM/YYYY-MM-DD-{name}.md`. |

## SRP debt summary (snapshot)

Files currently over the 300-line ceiling, in priority order:

1. [src/rapid_evidence/api.py](../src/rapid_evidence/api.py) — 1059 LOC
2. [src/rapid_evidence/spot/manager.py](../src/rapid_evidence/spot/manager.py) — 741 LOC
3. [src/rapid_evidence/batches/registry.py](../src/rapid_evidence/batches/registry.py) — 566 LOC
4. [src/rapid_evidence/spot/azure_cli_provider.py](../src/rapid_evidence/spot/azure_cli_provider.py) — 443 LOC

Files approaching the ceiling (watch on the next change):

- [web/src/components/scaling/swimlanePaths.ts](../web/src/components/scaling/swimlanePaths.ts) — 295 LOC (split `buildTidePlan` into separate area-path / target-path / event-marker builders before adding any new visual layer; cycle-3 hardening flagged this)
- [web/src/components/scaling/SwimlaneChart.tsx](../web/src/components/scaling/SwimlaneChart.tsx) — 294 LOC (extract `EventGlyph` to its own file before adding another SVG decoration)
- [src/rapid_evidence/worker/transport.py](../src/rapid_evidence/worker/transport.py) — 268 LOC
- [src/rapid_evidence/worker/agent_runtime.py](../src/rapid_evidence/worker/agent_runtime.py) — 264 LOC (mostly the embedded `AGENT_SCRIPT` string literal; safe — split further only if the daemon grows)
- [web/src/lib/i18n.tsx](../web/src/lib/i18n.tsx) — **850 LOC, OVER LIMIT.** Pure EN/KO translation dictionaries (no behaviour beyond `t(key, vars)`). Must split into `lib/i18n/en.ts` + `lib/i18n/ko.ts` + `lib/i18n/provider.tsx` before any further translation work. The premium-UX cycle (2026-05-30) added ~30 keys; further keys MUST land in a split layout.
- [web/src/lib/api.ts](../web/src/lib/api.ts) — **305 LOC, OVER LIMIT.** Untouched by the premium cycle. Split by resource (`api/batches.ts`, `api/scaling.ts`, `api/regions.ts`, `api/audit.ts`, `api/jobs.ts`, `api/dashboard.ts`) the next time a new endpoint is added.
- [src/rapid_evidence/worker/source.py](../src/rapid_evidence/worker/source.py) — 197 LOC
- [src/rapid_evidence/spot/scheduler.py](../src/rapid_evidence/spot/scheduler.py) — 171 LOC
- [src/rapid_evidence/metrics/collector.py](../src/rapid_evidence/metrics/collector.py) — 169 LOC
