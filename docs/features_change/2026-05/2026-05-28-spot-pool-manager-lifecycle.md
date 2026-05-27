# Spot pool manager + FastAPI lifespan orchestration

## What changed

- New `rapid_evidence.spot.manager.SpotPoolManager` — async orchestrator that
  owns the lifecycle of a `SpotVmScheduler`:
  1. **start(background=True)** warms the pool to `min_ready` and (by default)
     launches a heartbeat task and a reconcile task.
  2. **heartbeat loop** polls `provider.refresh_nodes()` every
     `heartbeat_interval` seconds, merges fresh provider state with locally
     tracked BUSY/DRAINING/PROVISIONING work, and emits `EvictionEvent` on
     READY→EVICTED / READY→FAILED transitions.
  3. **reconcile loop** every `reconcile_interval` seconds terminates dead
     nodes (EVICTED/FAILED) via the provider, drops their assignments, and
     calls `scheduler.ensure_min_ready()` so the pool is rewarmed.
  4. **scale_for(n)** computes a `SpotCapacityPlan` and synchronously asks
     the provider to scale up, bounded by `max_nodes`.
  5. **stop()** cancels the background tasks and terminates every active
     node via `scheduler.cleanup_all()`.
- All provider mutations (refresh / create / terminate / reserve / release)
  are serialised through an internal `asyncio.Lock` so the heartbeat,
  reconcile, scale, and reserve flows never race on the underlying
  subprocess provider.
- Sync provider calls run via `asyncio.to_thread` so the FastAPI event loop
  is never blocked by `az` CLI subprocess work.
- Snapshot exposes counters per node state (`ready`, `busy`, `provisioning`,
  `terminating`, `evicted`, `failed`, `terminated`, `draining`) plus running
  metrics (`heartbeat_count`, `reconcile_count`, `evictions_total`,
  `failures_total`, `nodes_created_total`, `nodes_replaced_total`,
  `nodes_terminated_total`, `scale_up_total`) and a bounded buffer of
  recent eviction events and lifecycle events.
- The fake `InMemorySpotVmProvider` gained a `simulate_state(node_id, state)`
  helper used by tests to deterministically inject EVICTED / FAILED.

## FastAPI integration

- `rapid_evidence.api` now uses an `@asynccontextmanager lifespan` that:
  - on startup, builds a `SpotPoolManager` from env vars and calls `start()`
    so the warm pool is ready before FastAPI accepts traffic;
  - on shutdown, calls `manager.stop()` to cancel loops and terminate all
    VMs.
- New routes:
  - `GET /pool/status` — returns the full snapshot (counters, metrics,
    nodes, recent eviction events, recent lifecycle events).
  - `POST /pool/scale` `{requested_tasks}` — asks the pool to scale up.
  - `POST /pool/heartbeat` — forces an immediate heartbeat (useful for
    operators / tests).
  - `POST /pool/reconcile` — forces an immediate reconcile.
- `POST /run` is now pool-aware: if the manager is running, it asks the pool
  to scale toward demand before executing the batch, and the response's
  `pool` field surfaces the live counters (`running`, `idle`,
  `provisioning`, `terminating`, `evicted_total`, `replaced_total`,
  `heartbeats`, `provider`).

## Environment variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `RAPID_EVIDENCE_POOL_AUTOSTART` | `true` | Disable lifespan pool start when `false` |
| `RAPID_EVIDENCE_SPOT_PROVIDER` | `in-memory` | `in-memory` (tests) or `azure-cli` |
| `RAPID_EVIDENCE_SPOT_MIN_READY` | `1` | Warm-pool floor |
| `RAPID_EVIDENCE_SPOT_MAX_NODES` | `4` | Hard ceiling |
| `RAPID_EVIDENCE_SPOT_PER_NODE` | `1` | Per-node task concurrency |
| `RAPID_EVIDENCE_SPOT_IDLE_TIMEOUT` | `600` | Seconds before idle nodes are eligible for scale-down |
| `RAPID_EVIDENCE_HEARTBEAT_SECONDS` | `15.0` | Heartbeat loop interval |
| `RAPID_EVIDENCE_RECONCILE_SECONDS` | `30.0` | Reconcile loop interval |
| `RAPID_EVIDENCE_AZURE_REGION` | `koreacentral` | Azure CLI provider region |
| `RAPID_EVIDENCE_AZURE_RESOURCE_GROUP` | `rapid-evidence` | Azure CLI provider RG |
| `RAPID_EVIDENCE_AZURE_VM_SIZE` | `Standard_D2as_v5` | Azure CLI provider VM size |

## Tests

- New `tests/test_spot_pool_manager.py` — 9 cases covering warm-up,
  shutdown cleanup, eviction detection + replacement, failure detection,
  scale-up, max-node ceiling, periodic background ticks, BUSY-state
  preservation across heartbeats, and constructor validation.
- `tests/test_api.py` extended with two lifespan cases: autostart on
  (verifies `/pool/status`, `/pool/scale`, `/pool/heartbeat`,
  `/pool/reconcile`) and autostart off (verifies `503` on scale).
