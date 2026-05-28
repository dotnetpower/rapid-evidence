# Frontend — Per-Node Dispatch Visibility

**Date:** 2026-05-28
**Status:** implemented

## Summary

Stage E (remote worker dispatch) wired requests to specific Spot
pool nodes, but the dashboard had no way to show which node handled
which request — making it hard to verify that the pool was actually
doing work (vs. the host doing the fetch locally). This change exposes
node-level evidence in three places.

## Pool panel — Spot Nodes table

`/dashboard/summary` now includes `pool.nodes: SpotNodeView[]`, a
list of node id, name, state, inflight count, and outbound IP for
every node currently tracked by the scheduler. The
`PoolPanel.NodesList` component renders this as a small table below
the scale-progress meters so the operator can see at a glance:

- how many spot nodes exist right now (matches the spot KPI card),
- whether outbound IP rotation actually happened (different IPs per
  node),
- which nodes have requests in flight.

## Pool panel — Recent Evictions list

`/dashboard/summary.pool.recent_evictions` carries the trailing 20
eviction events from `SpotPoolManager._eviction_history`. The
`PoolPanel.EvictionsList` component renders the last six in reverse
chronological order with their reason and a `· requeued N` suffix
when the manager re-queued tasks. Useful for spotting eviction storms
during a benchmark.

## Batches table — node count badge

`BatchProgress.metadata.node_counts` (added by the registry change)
maps `node_id → request_count`. `BatchesTable.tsx` shows the unique
node count next to the source name with a tooltip listing the full
breakdown, and a `⚠ N` glyph when `evictions_observed > 0`. This
gives a per-batch dispatch fingerprint without opening dev tools.

## Affected files

- `src/rapid_evidence/api.py` — `/dashboard/summary` schema.
- `src/rapid_evidence/batches/registry.py` — `BatchRecord.node_counts`
  accumulator + `BatchProgress.metadata.node_counts` surfacing.
- `src/rapid_evidence/spot/manager.py` — `snapshot()` returns
  `nodes` and `recent_evictions`.
- `web/src/lib/api.ts` — `DashboardSummary.pool.nodes` +
  `recent_evictions` types.
- `web/src/components/PoolPanel.tsx` — `NodesList` + `EvictionsList`.
- `web/src/components/BatchesTable.tsx` — node-count badge + eviction
  glyph.
