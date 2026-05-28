# Eviction Requeue Hook → BatchProgress

**Date:** 2026-05-28
**Status:** implemented

## Summary

When the Spot pool manager observes an `EvictionEvent` on a node, it
already buffered the list of `requeue_task_ids` for that node so that
the reconcile loop could later replace the VM. Stage E (remote worker
dispatch) attaches a `request_id` to every `WorkerDispatchPayload`, so
those `requeue_task_ids` are now meaningful identifiers — they are the
exact in-flight fetch requests that the evicted node was working on.

This change wires the manager → registry → batch progress path so the
host can:

1. Find the batch each request belongs to in O(1).
2. Increment an `evictions_observed` counter on that batch.
3. Surface the counter (and an in-memory list of recent eviction
   events) through `/dashboard/summary` and the per-batch
   `/batches/{id}` payload, where the dashboard renders it as a
   warning glyph in the batches table.

## Behaviour

- `BatchRegistry` keeps an internal `_request_index: dict[str, str]`
  (request_id → batch_id) populated when a batch is enqueued and
  cleared on terminal status.
- `BatchRegistry.notify_eviction(node_id, reason, request_ids)`:
  - looks each `request_id` up in `_request_index`
  - if found, increments `BatchRecord.evictions_observed` and stores
    the request_id under `evicted_request_ids` (capped at 64 to keep
    progress JSON bounded)
  - emits a `RuntimeEvent` to the audit ledger
- `api.py` lifespan starts an `_eviction_drain_loop` background task
  that polls `pool_manager.snapshot()["recent_evictions"]` at the
  reconcile interval and forwards each unseen event to
  `registry.notify_eviction(...)`. The loop is idempotent via an
  in-memory `_seen` set keyed by `(node_id, event_id)`.
- `BatchProgress.metadata` carries `evictions_observed` (count) and
  `node_counts` (request count per node) so the FE can decorate the
  batch row without an extra round-trip.

## Hardening

- The eviction history list inside `SpotPoolManager._eviction_history`
  is bounded by `_event_buffer` (default 200) and trimmed in
  `_consume_provider_events`, so the drain loop never sees an
  unbounded queue.
- `_request_index` purges entries on terminal batch status to avoid
  cross-batch contamination when the registry recycles short ids.
- The drain loop swallows `Exception` to avoid taking down the API
  on a transient pool snapshot error but logs at `WARNING` so the
  operator can spot a stuck loop.

## Tests

- `tests/test_batches.py::test_notify_eviction_marks_batch_progress`
  verifies that a synthetic eviction event increments the counter and
  appears on the matching batch's progress.

## Affected files

- `src/rapid_evidence/batches/registry.py`
- `src/rapid_evidence/api.py`
- `src/rapid_evidence/spot/manager.py` (recent_evictions snapshot)
- `tests/test_batches.py`
