# 2026-05-29 — Full Batches page with detail drawer

## Summary

Replaces the scaffold heading-only Batches page with a full operations view:
filter/sort bar, full-width batches table, and a URL-driven right-slide detail
drawer covering summary KPIs, per-node dispatch distribution, eviction impact,
and a reverse-chronological timeline backed by a new per-batch event log.

## Backend changes

- `BatchRecord` gains:
  - `history: list[dict]` — append-only event log capped FIFO at 256 entries.
    Each entry is `{ "timestamp": utc_now_iso(), "event_type": str, "payload": dict }`.
  - `evicted_request_ids: list[str]` — request IDs that hit at least one
    eviction; surfaced via `BatchProgress.metadata["evicted_request_ids"]`.
  - `record_event(event_type, payload)` — single recording helper that
    enforces the 256-cap.
- Lifecycle transitions write events:
  - `submit()` → `queued`
  - `BatchExecutor.run()` → `started` and `finished`
  - `BatchRegistry.cancel()` → `cancel_requested`
  - `BatchRegistry.notify_eviction()` → `evicted` (one event per affected
    batch, with the affected request IDs in the payload)
- `GET /batches/{id}/timeline` (already scaffolded) now returns the populated
  `record.history` list.

## Frontend changes

New files under `web/src/`:

- `pages/BatchesPage.tsx` — list page; reads `:batchId` from URL to open the
  drawer (deep-linkable). 2 s polling via React Query.
- `components/batches/BatchFilterBar.tsx` — segmented filter (all / active /
  terminal) + sort select (newest / rate / evictions).
- `components/batches/BatchListTable.tsx` — full table with columns
  batch / source / status / progress / rate / workers / nodes / evictions /
  created. Row click navigates to `/batches/:id`.
- `components/batches/BatchDetailDrawer.tsx` — sections: summary KPIs,
  per-node dispatch table (with share %), eviction impact (counter +
  affected request IDs), timeline (consumes `BatchTimelineList`), cancel
  footer button (disabled in terminal states). ESC closes; backdrop click
  closes.
- `components/batches/BatchTimelineList.tsx` — reverse-chrono renderer of
  `BatchTimelineEvent[]`.

Wiring:

- `main.tsx` — `/batches` and `/batches/:batchId` routes registered (both
  render `BatchesPage`; drawer opens when `batchId` is present).
- `components/AppShell.tsx` — Batches sidebar entry promoted from disabled
  to active link; `crumbKey()` recognises `/batches/*` paths.
- `lib/i18n.tsx` — `batches.page.*`, `batches.sort.*`, `batches.list.col.*`,
  `batches.drawer.summary.*`, `batches.drawer.nodes.*`,
  `batches.drawer.evictions.*`, `batches.drawer.timeline.*` keys added to
  both EN and KO dictionaries.
- `styles/app.css` — new `.drawer`, `.drawer-backdrop`, `.drawer-panel`,
  `.drawer-section`, `.drawer-kpis`, `.drawer-timeline`, `.drawer-list`
  classes. No existing rules modified.

## Tests

- `tests/test_batches.py::test_history_records_lifecycle_events_and_caps_at_256`
  — verifies queued/started/finished are recorded with structured payloads,
  eviction events include reason + request IDs, evicted IDs surface via
  `metadata`, and FIFO cap holds at 256 (oldest dropped first).
- `tests/test_api_batches.py::test_batch_timeline_endpoint_returns_recorded_events`
  + `test_batch_timeline_returns_404_for_unknown_batch` — exercise the API
  contract end-to-end.

## Verification

- `PYTHONPATH=src .venv/bin/python -m pytest -q` — 58 passed.
- `cd web && npm test -- --run` — 4 passed.
- `cd web && npm run build` — succeeds (single bundle, gzip 209 kB).
- `ruff check src/rapid_evidence/batches/` — clean.

## Not changed

- `web/src/components/BatchesTable.tsx` (small Throughput-page widget) is
  intentionally untouched; the full-page table lives in a sibling component.
- Other scaffold sidebar entries (regions/scaling/quota/audit) remain
  disabled — those pages are owned by separate follow-up sessions.

## Known SRP debt (pre-existing, unchanged by this change)

- `src/rapid_evidence/batches/registry.py` is now 563 LOC (was 507) — split
  candidates are listed in `docs/CODEMAP.md`. The history field is the
  minimum addition required for the timeline endpoint; further growth must
  trigger the documented split.
- `src/rapid_evidence/api.py` remains 765 LOC; this change only fills in
  the existing `/batches/{id}/timeline` body and adds no new routes.
