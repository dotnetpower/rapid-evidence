You are building a Python 3.11+ library called `rapid_evidence`: a policy-governed
burst evidence collection toolkit for public-health / research crisis use cases. It
must be reimplemented from scratch under `rapid_evidence/` with its own
`pyproject.toml`, `tests/`, `benchmarks/`, and `README.md`. Follow every invariant
below — they are not suggestions.

================================================================
DESIGN PHILOSOPHY (non-negotiable)
================================================================

1.  Managed collection, NOT rate-limit evasion.
    Sources must register a SourcePolicy (concurrency, min_delay_seconds, batch
    size, required headers, retry attempts, allowed methods). The scheduler MUST
    refuse to enqueue or dispatch work for a source that has no policy.

2.  Swappable components.
    Queue, storage sink, worker provider, audit sink are Protocols. The library
    ships an in-memory queue, a filesystem sink, a local provider, an in-memory
    Spot VM provider (for tests), and an Azure CLI backed Spot VM provider. The
    scheduler must not import any of them concretely except through DI.

3.  Bounded micro-batches.
    Workers pull bounded chunks via `dequeue_batch(source, n)`. The queue MUST
    cap `max_queued` and reject overflow with `QueueCapacityError`.

4.  Safety defaults at every boundary.
    - URL guard validates that every fetched URL is HTTPS, resolves to a
      *global* (non-private, non-loopback, non-link-local, non-multicast,
      non-reserved) IP, AND re-validates after every redirect using a
      `GuardedHTTPTransport`.
    - `httpx.Client.stream()` with bounded `iter_bytes()` capture so a huge
      response cannot exhaust memory before truncation.
    - Result files written with mode 0600 inside a 0700 directory + fsync.
    - Worker dequeues must `requeue_front` on sink write failure (no lost work).
    - In-memory dedupe set MUST release keys on dequeue, never grow unbounded.

5.  Measurable, never fake-success.
    Every long-running operation surfaces a numeric metric (count, seconds,
    bytes, p95). "STARTED" alone is not progress.

6.  Critical-0 hardening loop.
    Every code change goes through a severity-ordered review (Critical / High /
    Medium / Low). Iterate until Critical = 0 and High = 0 before shipping. A
    `HARDENING_REVIEW.md` lists every finding and the fix.

================================================================
MODULE LAYOUT (use these names verbatim)
================================================================

rapid_evidence/
  __init__.py                # exports FetchRequest, FetchResult, SurgeLimits,
                             # WorkerLease, WorkerSpec, SourcePolicy,
                             # SurgeOrchestrator, SpotPoolConfig, SpotVmScheduler,
                             # InMemorySpotVmProvider
  core/
    __init__.py
    errors.py                # RapidEvidenceError + subclasses:
                             #   PolicyViolationError, QueueCapacityError,
                             #   ProviderError, SourceFetchError
    ids.py                   # `new_id(prefix)` → short, URL-safe, prefixed id
    models.py                # FetchRequest, FetchResult, RequestStatus,
                             #   SourcePolicy, SurgeLimits, WorkerSpec,
                             #   WorkerLease, WorkerStatus (frozen dataclasses)
    time.py                  # `utc_now_iso()` returning RFC 3339 strings
  policy/
    __init__.py
    policy_store.py          # PolicyStore: register(policy), require(source).
                             # SourcePolicy.validate_request enforces required
                             # headers, method allowlist, batch_size cap.
    defaults.py              # `default_policy_store()` — ships a `generic-http`
                             # policy used by the local pipeline + tests
  queue/
    __init__.py
    memory.py                # MemoryRequestQueue with max_queued (default
                             # unbounded), `enqueue`, `dequeue_batch`,
                             # `requeue_front`, `size`. Releases dedupe on
                             # dequeue. Raises QueueCapacityError on overflow.
  sources/
    __init__.py
    url_guard.py             # `validate_public_http_url(url)` — scheme, host
                             # DNS resolution, global-address check.
                             # `GuardedHTTPTransport` wraps httpx transport to
                             # re-validate every redirect.
    generic_http.py          # GenericHttpSource: bounded streaming fetch,
                             # constructor-validated timeouts, retry budget,
                             # honours `Retry-After` (delta seconds OR RFC HTTP
                             # date, capped to a sane max).
  providers/
    __init__.py              # exports LocalWorkerProvider only
    base.py                  # WorkerProvider Protocol: provision_worker,
                             # terminate_worker, status (returns immutable
                             # lease snapshots)
    local.py                 # LocalWorkerProvider: in-process, used for
                             # `rapidfetch run-local`
  orchestrator/
    __init__.py
    scheduler.py             # SurgeOrchestrator(policies, limits) with
                             # `run_local_once(source, queue, sink, provider,
                             # source_client) -> SurgePlan`. SurgeLimits caps
                             # max_workers, runtime, USD budget,
                             # estimated_worker_second_usd.
  storage/
    __init__.py
    filesystem.py            # FileSystemResultSink: write FetchResult to
                             # `<dir>/<request_id>.json` with 0600 perms inside
                             # 0700 dir, fsync after write, list_result_ids().
  audit/
    __init__.py
    ledger.py                # JsonlAuditLedger.record(event_type, payload)
                             # appends an `{event_type, timestamp, payload}`
                             # line; thread-safe via threading.Lock; 0600 file
                             # in 0700 dir; one fsync per record.
  spot/
    __init__.py              # exports SpotPoolConfig, SpotPoolStatus, SpotNode,
                             # SpotNodeState, SpotReservation, SpotCapacityPlan,
                             # IpDistribution, EvictionEvent, QuotaSnapshot,
                             # CleanupReport, ObservedSpotTimings,
                             # estimate_spot_capacity, compute_ip_distribution,
                             # SpotVmProvider, SpotVmDiscoveryProvider,
                             # SpotAuditSink, SpotVmScheduler,
                             # InMemorySpotVmProvider, AzureCliSpotVmProvider,
                             # AzureSpotVmConfig
    models.py
    provider.py              # SpotVmProvider Protocol (create_nodes,
                             # refresh_nodes, terminate_nodes).
                             # SpotVmDiscoveryProvider adds
                             # discover_existing_nodes + check_quota.
                             # SpotAuditSink: .record(event_type, payload).
    sizing.py                # estimate_spot_capacity(config, requested_tasks,
                             # ready_nodes, active_nodes, timings) -> plan.
                             # Plan reports immediate/queued/overflow/target/
                             # scale_up/scale_down WITHOUT blocking on cold VMs.
    scheduler.py             # SpotVmScheduler (see "Spot scheduler" below)
    fake.py                  # InMemorySpotVmProvider for deterministic tests
    azure_cli_provider.py    # AzureCliSpotVmProvider (see "Azure provider"
                             # below) — only az CLI, no Python Azure SDK
  cli.py                     # `rapidfetch` entry point: `run-local`,
                             # `spot-plan`, `spot-quota`

tests/
  test_url_guard.py
  test_policy_and_queue.py
  test_generic_http_source.py
  test_orchestrator_and_worker.py
  test_audit_ledger.py
  test_cli.py                # spot-plan output shape + run-local arg
                             # validation + regression that removed commands
                             # (e.g. aci-plan) fail loudly
  test_spot_vm_scheduler.py  # covers EVERY hardening point listed below
  test_live_archive_benchmark.py  # parser-only tests, no live network

benchmarks/
  benchmark_performance.py            # synthetic: queue, url_guard,
                                      # mock httpx, local pipeline.
  benchmark_live_archive.py           # opt-in: real arXiv / PubMed batch
  benchmark_spot_scheduler.py         # synthetic warm-pool sizing
  benchmark_spot_30_vms_live.py       # opt-in: real Azure 30-VM deployment

================================================================
KEY DATA SHAPES (frozen dataclasses unless noted)
================================================================

FetchRequest:
  request_id (auto, prefixed), source (normalized lowercase), target (str),
  headers (dict[str,str]), method ("GET" default), body (bytes|None),
  metadata (dict).

SourcePolicy:
  source, min_delay_seconds, max_concurrency, max_batch_size, max_workers,
  required_headers, allowed_methods, max_attempts, retry_after_seconds,
  max_request_bytes.

SpotPoolConfig:
  min_ready, max_nodes, per_nodeYou are building a Python 3.11+ library called `rapid_evidence`: a policy-governed
burst evidence collection toolkit for public-health / research crisis use cases. It
must be reimplemented from scratch under `rapid_evidence/` with its own
`pyproject.toml`, `tests/`, `benchmarks/`, and `README.md`. Follow every invariant
below — they are not suggestions.

================================================================
DESIGN PHILOSOPHY (non-negotiable)
================================================================

1.  Managed collection, NOT rate-limit evasion.
    Sources must register a SourcePolicy (concurrency, min_delay_seconds, batch
    size, required headers, retry attempts, allowed methods). The scheduler MUST
    refuse to enqueue or dispatch work for a source that has no policy.

2.  Swappable components.
    Queue, storage sink, worker provider, audit sink are Protocols. The library
    ships an in-memory queue, a filesystem sink, a local provider, an in-memory
    Spot VM provider (for tests), and an Azure CLI backed Spot VM provider. The
    scheduler must not import any of them concretely except through DI.

3.  Bounded micro-batches.
    Workers pull bounded chunks via `dequeue_batch(source, n)`. The queue MUST
    cap `max_queued` and reject overflow with `QueueCapacityError`.

4.  Safety defaults at every boundary.
    - URL guard validates that every fetched URL is HTTPS, resolves to a
      *global* (non-private, non-loopback, non-link-local, non-multicast,
      non-reserved) IP, AND re-validates after every redirect using a
      `GuardedHTTPTransport`.
    - `httpx.Client.stream()` with bounded `iter_bytes()` capture so a huge
      response cannot exhaust memory before truncation.
    - Result files written with mode 0600 inside a 0700 directory + fsync.
    - Worker dequeues must `requeue_front` on sink write failure (no lost work).
    - In-memory dedupe set MUST release keys on dequeue, never grow unbounded.

5.  Measurable, never fake-success.
    Every long-running operation surfaces a numeric metric (count, seconds,
    bytes, p95). "STARTED" alone is not progress.

6.  Critical-0 hardening loop.
    Every code change goes through a severity-ordered review (Critical / High /
    Medium / Low). Iterate until Critical = 0 and High = 0 before shipping. A
    `HARDENING_REVIEW.md` lists every finding and the fix.

================================================================
MODULE LAYOUT (use these names verbatim)
================================================================

rapid_evidence/
  __init__.py                # exports FetchRequest, FetchResult, SurgeLimits,
                             # WorkerLease, WorkerSpec, SourcePolicy,
                             # SurgeOrchestrator, SpotPoolConfig, SpotVmScheduler,
                             # InMemorySpotVmProvider
  core/
    __init__.py
    errors.py                # RapidEvidenceError + subclasses:
                             #   PolicyViolationError, QueueCapacityError,
                             #   ProviderError, SourceFetchError
    ids.py                   # `new_id(prefix)` → short, URL-safe, prefixed id
    models.py                # FetchRequest, FetchResult, RequestStatus,
                             #   SourcePolicy, SurgeLimits, WorkerSpec,
                             #   WorkerLease, WorkerStatus (frozen dataclasses)
    time.py                  # `utc_now_iso()` returning RFC 3339 strings
  policy/
    __init__.py
    policy_store.py          # PolicyStore: register(policy), require(source).
                             # SourcePolicy.validate_request enforces required
                             # headers, method allowlist, batch_size cap.
    defaults.py              # `default_policy_store()` — ships a `generic-http`
                             # policy used by the local pipeline + tests
  queue/
    __init__.py
    memory.py                # MemoryRequestQueue with max_queued (default
                             # unbounded), `enqueue`, `dequeue_batch`,
                             # `requeue_front`, `size`. Releases dedupe on
                             # dequeue. Raises QueueCapacityError on overflow.
  sources/
    __init__.py
    url_guard.py             # `validate_public_http_url(url)` — scheme, host
                             # DNS resolution, global-address check.
                             # `GuardedHTTPTransport` wraps httpx transport to
                             # re-validate every redirect.
    generic_http.py          # GenericHttpSource: bounded streaming fetch,
                             # constructor-validated timeouts, retry budget,
                             # honours `Retry-After` (delta seconds OR RFC HTTP
                             # date, capped to a sane max).
  providers/
    __init__.py              # exports LocalWorkerProvider only
    base.py                  # WorkerProvider Protocol: provision_worker,
                             # terminate_worker, status (returns immutable
                             # lease snapshots)
    local.py                 # LocalWorkerProvider: in-process, used for
                             # `rapidfetch run-local`
  orchestrator/
    __init__.py
    scheduler.py             # SurgeOrchestrator(policies, limits) with
                             # `run_local_once(source, queue, sink, provider,
                             # source_client) -> SurgePlan`. SurgeLimits caps
                             # max_workers, runtime, USD budget,
                             # estimated_worker_second_usd.
  storage/
    __init__.py
    filesystem.py            # FileSystemResultSink: write FetchResult to
                             # `<dir>/<request_id>.json` with 0600 perms inside
                             # 0700 dir, fsync after write, list_result_ids().
  audit/
    __init__.py
    ledger.py                # JsonlAuditLedger.record(event_type, payload)
                             # appends an `{event_type, timestamp, payload}`
                             # line; thread-safe via threading.Lock; 0600 file
                             # in 0700 dir; one fsync per record.
  spot/
    __init__.py              # exports SpotPoolConfig, SpotPoolStatus, SpotNode,
                             # SpotNodeState, SpotReservation, SpotCapacityPlan,
                             # IpDistribution, EvictionEvent, QuotaSnapshot,
                             # CleanupReport, ObservedSpotTimings,
                             # estimate_spot_capacity, compute_ip_distribution,
                             # SpotVmProvider, SpotVmDiscoveryProvider,
                             # SpotAuditSink, SpotVmScheduler,
                             # InMemorySpotVmProvider, AzureCliSpotVmProvider,
                             # AzureSpotVmConfig
    models.py
    provider.py              # SpotVmProvider Protocol (create_nodes,
                             # refresh_nodes, terminate_nodes).
                             # SpotVmDiscoveryProvider adds
                             # discover_existing_nodes + check_quota.
                             # SpotAuditSink: .record(event_type, payload).
    sizing.py                # estimate_spot_capacity(config, requested_tasks,
                             # ready_nodes, active_nodes, timings) -> plan.
                             # Plan reports immediate/queued/overflow/target/
                             # scale_up/scale_down WITHOUT blocking on cold VMs.
    scheduler.py             # SpotVmScheduler (see "Spot scheduler" below)
    fake.py                  # InMemorySpotVmProvider for deterministic tests
    azure_cli_provider.py    # AzureCliSpotVmProvider (see "Azure provider"
                             # below) — only az CLI, no Python Azure SDK
  cli.py                     # `rapidfetch` entry point: `run-local`,
                             # `spot-plan`, `spot-quota`

tests/
  test_url_guard.py
  test_policy_and_queue.py
  test_generic_http_source.py
  test_orchestrator_and_worker.py
  test_audit_ledger.py
  test_cli.py                # spot-plan output shape + run-local arg
                             # validation + regression that removed commands
                             # (e.g. aci-plan) fail loudly
  test_spot_vm_scheduler.py  # covers EVERY hardening point listed below
  test_live_archive_benchmark.py  # parser-only tests, no live network

benchmarks/
  benchmark_performance.py            # synthetic: queue, url_guard,
                                      # mock httpx, local pipeline.
  benchmark_live_archive.py           # opt-in: real arXiv / PubMed batch
  benchmark_spot_scheduler.py         # synthetic warm-pool sizing
  benchmark_spot_30_vms_live.py       # opt-in: real Azure 30-VM deployment

================================================================
KEY DATA SHAPES (frozen dataclasses unless noted)
================================================================

FetchRequest:
  request_id (auto, prefixed), source (normalized lowercase), target (str),
  headers (dict[str,str]), method ("GET" default), body (bytes|None),
  metadata (dict).

SourcePolicy:
  source, min_delay_seconds, max_concurrency, max_batch_size, max_workers,
  required_headers, allowed_methods, max_attempts, retry_after_seconds,
  max_request_bytes.

SpotPoolConfig:
  min_ready, max_nodes, per_node