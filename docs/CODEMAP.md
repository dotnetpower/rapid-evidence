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
| [src/rapid_evidence/api.py](../src/rapid_evidence/api.py) | 656 | **OVER LIMIT.** FastAPI app: lifespan, env config helpers, `RunRequest`/`RunResponse`, `/run`, `/batches/*`, `/dashboard/*`, eviction drain loop. Split candidates: `api/app.py` (lifespan + DI), `api/routes_batches.py`, `api/routes_dashboard.py`, `api/config.py` (`_env_*`, `_build_*`). |

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
| [src/rapid_evidence/metrics/collector.py](../src/rapid_evidence/metrics/collector.py) | 155 | `MetricSample`, `MetricsCollector` (rolling window), `build_metric_sample(...)`. |

## batches/ — batch lifecycle

| File | LOC | Responsibility |
| ---- | --: | -------------- |
| [src/rapid_evidence/batches/registry.py](../src/rapid_evidence/batches/registry.py) | 507 | **OVER LIMIT.** Contains `BatchStatus`, `SourceClient` Protocol, `ResultSink` Protocol, `BatchProgress`, `BatchRecord`, `BatchExecutor`, `BatchRegistry`. Split candidates: `batches/models.py` (status + dataclasses), `batches/executor.py` (`BatchExecutor`), `batches/registry.py` (registry only), `batches/protocols.py` (Protocols). |

## spot/ — Azure Spot VM pool

| File | LOC | Responsibility |
| ---- | --: | -------------- |
| [src/rapid_evidence/spot/models.py](../src/rapid_evidence/spot/models.py) | 119 | `SpotPoolConfig`, `SpotPoolStatus`, `SpotNode`, `SpotNodeState`, `SpotReservation`, `SpotCapacityPlan`, `IpDistribution`, `EvictionEvent`, `QuotaSnapshot`, `CleanupReport`, `ObservedSpotTimings`. |
| [src/rapid_evidence/spot/provider.py](../src/rapid_evidence/spot/provider.py) | 24 | `SpotVmProvider` Protocol, `SpotVmDiscoveryProvider`, `SpotAuditSink`. |
| [src/rapid_evidence/spot/sizing.py](../src/rapid_evidence/spot/sizing.py) | 19 | `estimate_spot_capacity(...)` — non-blocking warm-pool plan. |
| [src/rapid_evidence/spot/scheduler.py](../src/rapid_evidence/spot/scheduler.py) | 171 | `SpotVmScheduler` — pure planner over provider snapshots. |
| [src/rapid_evidence/spot/fake.py](../src/rapid_evidence/spot/fake.py) | 70 | `InMemorySpotVmProvider` — deterministic test double. |
| [src/rapid_evidence/spot/manager.py](../src/rapid_evidence/spot/manager.py) | 572 | **OVER LIMIT.** `PoolEvent`, `PoolCounters`, `PoolMetrics`, `SpotPoolManager` (lifecycle, eviction drain, metrics). Split candidates: `spot/pool_metrics.py`, `spot/pool_lifecycle.py`, `spot/manager.py` (facade). |
| [src/rapid_evidence/spot/azure_cli_provider.py](../src/rapid_evidence/spot/azure_cli_provider.py) | 443 | **OVER LIMIT.** `AzureCliSpotVmProvider`, `AzureSpotVmConfig` — only `az` CLI, no Azure SDK. Split candidates: `spot/azure/config.py`, `spot/azure/cli.py` (subprocess wrapper), `spot/azure/provider.py`. |

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
| [web/src/main.tsx](../web/src/main.tsx) | React entrypoint; wraps app in `I18nProvider` + `QueryClientProvider`. |
| [web/src/lib/api.ts](../web/src/lib/api.ts) | Backend API client. |
| [web/src/lib/format.ts](../web/src/lib/format.ts) | Display formatters. |
| [web/src/lib/i18n.tsx](../web/src/lib/i18n.tsx) | EN/KO i18n context (`I18nProvider`, `useI18n`, `t(key, vars)`). LocalStorage-backed. |
| [web/src/components/AppShell.tsx](../web/src/components/AppShell.tsx) | App shell layout, titlebar with EN/한 language toggle. |
| [web/src/components/KpiCard.tsx](../web/src/components/KpiCard.tsx) | KPI card. |
| [web/src/components/PoolPanel.tsx](../web/src/components/PoolPanel.tsx) | Spot pool panel — counters, Spot Nodes table, Recent Evictions list. |
| [web/src/components/BatchesTable.tsx](../web/src/components/BatchesTable.tsx) | Batches table — per-batch node count + eviction glyph. |
| [web/src/components/audit/EventFilterBar.tsx](../web/src/components/audit/EventFilterBar.tsx) | Chip-style multi-select filter over the unique `event_type`s in the audit ring buffer. |
| [web/src/components/audit/EventRow.tsx](../web/src/components/audit/EventRow.tsx) | Audit row: relative + absolute timestamp, colour-coded type pill, on-demand payload toggle. |
| [web/src/components/scaling/SwimlaneChart.tsx](../web/src/components/scaling/SwimlaneChart.tsx) | recharts `ComposedChart` of ready/busy/provisioning/draining VMs (stacked area) with scale-event markers. |
| [web/src/components/scaling/EventMarkerList.tsx](../web/src/components/scaling/EventMarkerList.tsx) | Newest-first scale-events list paired with the SwimlaneChart. |
| [web/src/components/NewBatchDialog.tsx](../web/src/components/NewBatchDialog.tsx) | New batch dialog. |
| [web/src/components/ThroughputChart.tsx](../web/src/components/ThroughputChart.tsx) | Throughput chart. |
| [web/src/pages/ThroughputPage.tsx](../web/src/pages/ThroughputPage.tsx) | Throughput page route. |
| [web/src/pages/AuditPage.tsx](../web/src/pages/AuditPage.tsx) | Audit page route. Tails `GET /events` via incremental `since=` cursor; bounded local buffer (500 events); filter chips. |
| [web/src/pages/ScalingTimelinePage.tsx](../web/src/pages/ScalingTimelinePage.tsx) | Scaling timeline page route. Reads `GET /scaling/timeline`; 15m/60m/6h window toggle; SwimlaneChart + EventMarkerList. |
| [web/src/test/setup.ts](../web/src/test/setup.ts) | Vitest setup hook. |
| [web/src/styles/audit.css](../web/src/styles/audit.css) | Page-scoped styles for the Audit page (imported by `AuditPage.tsx`). Kept separate from `app.css` to avoid races with other sessions editing the shared stylesheet. |
| [web/src/styles/scaling.css](../web/src/styles/scaling.css) | Page-scoped styles for the Scaling Timeline page (imported by `ScalingTimelinePage.tsx`). |
| [web/src/__tests__/format.test.ts](../web/src/__tests__/format.test.ts) | Vitest suite for `lib/format`. |

## Scripts & docs

| Path | Responsibility |
| ---- | -------------- |
| [scripts/spot_vm_ip_probe.py](../scripts/spot_vm_ip_probe.py) | Operational probe to enumerate outbound IPs across spot VMs. |
| [docs/features_change/](../docs/features_change/) | Per-change feature notes, organised `YYYY-MM/YYYY-MM-DD-{name}.md`. |

## SRP debt summary (snapshot)

Files currently over the 300-line ceiling, in priority order:

1. [src/rapid_evidence/api.py](../src/rapid_evidence/api.py) — 656 LOC
2. [src/rapid_evidence/spot/manager.py](../src/rapid_evidence/spot/manager.py) — 572 LOC
3. [src/rapid_evidence/batches/registry.py](../src/rapid_evidence/batches/registry.py) — 507 LOC
4. [src/rapid_evidence/spot/azure_cli_provider.py](../src/rapid_evidence/spot/azure_cli_provider.py) — 443 LOC

Files approaching the ceiling (watch on the next change):

- [src/rapid_evidence/worker/transport.py](../src/rapid_evidence/worker/transport.py) — 268 LOC
- [src/rapid_evidence/worker/agent_runtime.py](../src/rapid_evidence/worker/agent_runtime.py) — 264 LOC (mostly the embedded `AGENT_SCRIPT` string literal; safe — split further only if the daemon grows)
- [web/src/lib/i18n.tsx](../web/src/lib/i18n.tsx) — 279 LOC (translation dictionaries; split into `lib/i18n/en.ts` + `lib/i18n/ko.ts` if a third language is added)
- [src/rapid_evidence/worker/source.py](../src/rapid_evidence/worker/source.py) — 197 LOC
- [src/rapid_evidence/spot/scheduler.py](../src/rapid_evidence/spot/scheduler.py) — 171 LOC
- [src/rapid_evidence/metrics/collector.py](../src/rapid_evidence/metrics/collector.py) — 155 LOC
