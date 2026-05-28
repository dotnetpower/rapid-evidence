# Stage E — Remote Worker Dispatch

**Date:** 2026-05-28
**Status:** implemented (in-memory transport verified end-to-end; HTTP transport gated on real Azure provider testing)

## Summary

The batch executor used to call `source_client.fetch()` directly inside
the host (FastAPI) event loop, which meant the Spot pool nodes only
existed as bookkeeping — no real fetch ever ran on them. Stage E moves
the fetch onto the pool nodes: the host reserves a node, sends a
dispatch payload over a `WorkerTransport`, and writes the result back
to the local sink.

The transport is pluggable:

- `InMemoryWorkerTransport` — fast in-process echo handler used by
  tests and the local dashboard demo. Supports a configurable
  `simulated_delay_seconds` so throughput is visible in the UI.
- `HttpWorkerTransport` — talks to a stdlib HTTP agent on each Spot VM
  at `http://<public_ip>:8765/fetch` with `Authorization: Bearer
  <shared_secret>`. The agent is installed by the Azure CLI provider's
  cloud-init.

## New modules

- `rapid_evidence/worker/transport.py`
  - `WorkerDispatchPayload`, `WorkerDispatchResult` (frozen
    dataclasses, JSON-serialisable)
  - `WorkerTransport` protocol
  - `InMemoryWorkerTransport`, `HttpWorkerTransport`
  - `WorkerDispatchError` (retryable failure raised by transport)
- `rapid_evidence/worker/source.py`
  - `RemoteWorkerSource` — `SourceClient` implementation that
    reserves a pool node, dispatches, retries on a different node when
    a dispatch fails, optionally calls `scale_for(1)` on starvation,
    and always releases the node in a `finally` block (except when the
    node was marked FAILED, which would otherwise be flipped back to
    READY by `scheduler.release`).
- `rapid_evidence/worker/agent_script.py`
  - `AGENT_SCRIPT` — full source for the stdlib-only on-VM fetch
    daemon (HTTPS-only, GET/HEAD only, body cap 5 MB, timeout cap 60 s,
    base64-encoded body in response, refreshes outbound_ip every
    120 s).
  - `AgentInstallSpec` — renders the systemd unit, env file, and the
    cloud-init `write_files` + `runcmd` blocks the host needs to drop
    on a Spot VM.
  - `generate_agent_secret()` — `secrets.token_urlsafe(32)`.

## Wiring changes

- `rapid_evidence/api.py`
  - New `default_worker_transport_factory(provider)` picks the
    transport matching the active Spot provider.
  - `build_batch_registry(...)` takes `pool_manager` and
    `worker_transport` and constructs `RemoteWorkerSource` per source
    when both are present (gated by env
    `RAPID_EVIDENCE_REMOTE_DISPATCH`, default `true`).
  - `lifespan` builds the manager + transport before the registry and
    closes the transport (`await transport.aclose()`) on shutdown.
- `rapid_evidence/spot/manager.py`
  - `get_node(node_id)` — local view of a single node.
  - `async mark_node_failed(node_id, reason)` — sets state FAILED,
    clears assignments, increments `failures_total`, records a
    `node_failed_locally` event. The reconcile loop replaces the node.
- `rapid_evidence/batches/registry.py`
  - `BatchExecutor._invoke_source` now detects async sources
    (`fetch_async` coroutine vs sync `fetch`) and routes
    appropriately, so the `RemoteWorkerSource` never blocks the loop
    on `asyncio.to_thread`.
  - `outbound_ip`, `node_id`, `attempts` are forwarded into the
    fetch-result metrics when present.
- `rapid_evidence/spot/azure_cli_provider.py`
  - `AzureSpotVmConfig` gains `agent_port`, `agent_shared_secret`,
    `agent_enabled`.
  - Provider generates a shared secret at construction time and
    exposes it via `agent_shared_secret`/`agent_port`.
  - `_render_cloud_init` splices the agent's `write_files` + extra
    `runcmd` entries into the existing cloud-init document.
  - `_ensure_infrastructure` adds an inbound NSG rule allowing TCP on
    the agent port (auth is bearer-only — operators should narrow the
    source-address-prefix in production).

## Environment variables

| name | default | purpose |
| --- | --- | --- |
| `RAPID_EVIDENCE_REMOTE_DISPATCH` | `true` | when `false`, the legacy single-process executor is used (tests set this). |
| `RAPID_EVIDENCE_AGENT_DEMO_LATENCY_SECONDS` | `0.0` | injects per-dispatch sleep into `InMemoryWorkerTransport` so the dashboard shows real-looking throughput. |
| `RAPID_EVIDENCE_AGENT_SCHEME` | `http` | scheme for `HttpWorkerTransport`. |
| `RAPID_EVIDENCE_AGENT_CONNECT_TIMEOUT_SECONDS` | `5.0` | HTTP connect timeout. |
| `RAPID_EVIDENCE_AGENT_REQUEST_TIMEOUT_SECONDS` | `120.0` | HTTP request timeout. |
| `RAPID_EVIDENCE_RESERVE_WAIT_SECONDS` | `30.0` | how long a `fetch_async` will wait for a ready node before failing. |

## Tests

- `tests/test_remote_worker.py` — 6 cases:
  - in-memory default echo returns 200 with the URL
  - in-memory handler can raise `WorkerDispatchError`
  - `simulated_delay_seconds` is honoured
  - `RemoteWorkerSource.fetch_async` happy path (reserves, dispatches,
    releases)
  - failure on first node retries on a different node (verifies that
    the second invocation lands on a distinct `node_id`)
  - raises `SourceFetchError` when no ready node arrives before the
    reservation deadline

Full suite: `uv run pytest -q` → 46 passed.

## Browser verification

With `RAPID_EVIDENCE_AGENT_DEMO_LATENCY_SECONDS=0.15`, a 6-URL batch
submitted via `POST /batches`:

- batch completed with `throughput_per_second=0.682` (≈ 4 workers × 0.15 s)
- `/pool/status` events show
  - 4 `reserve` events with 2 unassigned → `scale_up` event creating 2
    more nodes → 4 more `reserve` events all assigned
  - matching `release` events as each fetch completed
- 4 nodes returned to `ready` after the batch finished

## Known follow-ups (not blocking)

- `HttpWorkerTransport` is implemented but only exercised by unit
  tests; verifying against a real Azure pool will require running the
  opt-in `benchmark_spot_30_vms_live.py` (Stage F).
- The NSG rule currently uses `--source-address-prefix Internet`. For
  production the host should constrain this to its own egress IP only.
- Per-fetch metadata (`outbound_ip`, `node_id`) is captured on the
  `FetchResult` but is not yet surfaced in the BatchesTable UI.
