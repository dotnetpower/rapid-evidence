# 2026-05-29 — Audit + Scaling Timeline pages

## Scope

Materialise the **Audit** (`/audit`) and **Scaling Timeline** (`/scaling`)
sidebar pages, plus the small backend hooks they need. The previous
scaffold commit landed the page stubs, the `GET /events` /
`GET /scaling/timeline` endpoints, and the `SpotPoolManager.event_buffer`
constructor argument; this change fills the page bodies and wires the
buffer to an environment variable so the UI has a useful history depth.

## Why now

Both pages consume the manager's `recent_events` ring buffer. The
default ring size on `SpotPoolManager` (`event_buffer=200`) is already a
sensible default but was previously truncated in `snapshot()` to the
last 20 events. With a 2 s auto-refresh, the Audit page would have shown
at most 20 records, and `/scaling/timeline` would only carry 20 events
into the chart — too short to be useful.

## Backend changes

### `src/rapid_evidence/spot/manager.py`

- `snapshot()["recent_events"]` now returns the full `_event_buffer`
  window instead of being hard-capped at `_events[-20:]`. Cap stays at
  `_event_buffer` (default 200) — bounded as before.
- Removed an unused `field` import flagged by ruff.

### `src/rapid_evidence/api.py`

- `build_pool_manager()` now reads `RAPID_EVIDENCE_EVENT_BUFFER`
  (default 200) and passes it to `SpotPoolManager(event_buffer=...)`.
  Same `_env_int` parser used by the rest of the env-driven config —
  invalid integers fail fast at startup.

The existing scaffold endpoints kept their shape:

- `GET /events?since=<iso>&limit=<n>` — returns
  `{"events": [...]}`. `since` filters events strictly newer than the
  given ISO timestamp; `limit` is clamped to `[1, 1000]` so callers
  can't ask for unbounded payloads.
- `GET /scaling/timeline?window_seconds=<float>` — returns
  `{"window_seconds", "samples", "events"}`. `samples` is the metrics
  collector window; `events` is `recent_events` filtered to the
  forward-looking scaling event types (`node_provisioned`,
  `node_evicted`, `scale_up`, `scale_down`, `node_replaced`). Manager
  does not yet emit those types — they will start showing up when
  later sessions add the emit-points; today the section renders the
  "no scale events" empty state, which is correct.

### `src/rapid_evidence/spot/scheduler.py`

Cleared 3 pre-existing ruff F401/F841 errors so the spot package now
passes `ruff check src/rapid_evidence/spot/` clean. No behaviour change.

## Tests

- `tests/test_spot_pool_manager.py` — appended two tests:
  - `test_manager_event_buffer_caps_recent_events_in_snapshot`
    asserts that with `event_buffer=5`, calling `heartbeat_once()` 20
    times yields a snapshot with `len(recent_events) <= 5`.
  - `test_manager_rejects_invalid_event_buffer` covers the existing
    `event_buffer <= 0` guard.
- `tests/test_api_events_scaling.py` (new) — covers
  `GET /events` (envelope, since-filter, limit clamp, autostart=false
  empty response), `GET /scaling/timeline` (envelope shape + scaling
  event filter membership), and verifies the
  `RAPID_EVIDENCE_EVENT_BUFFER` env var actually shrinks the snapshot
  ring size end-to-end.

Full suite still green: `58 passed`.

## Frontend changes

New files:

- `web/src/pages/AuditPage.tsx` (replaces the stub) — useQuery against
  `/events` with `refetchInterval: 2000`, incremental tail via
  `since=<last-timestamp>`. Local state caps at
  `MAX_BUFFERED_EVENTS = 500`. Dedup uses a fingerprint set
  (`timestamp|event_type|payload`) so React Strict Mode double-effects
  don't insert the same record twice, and each stored event gets a
  monotonic `_id` for use as the React `key` (eliminates the previous
  duplicate-key console warnings when many events share the same
  timestamp). Newest-first ordering; clickable event-type filter chips.
- `web/src/components/audit/EventFilterBar.tsx` — chip-style
  multi-select filter over the unique `event_type`s currently in the
  buffer.
- `web/src/components/audit/EventRow.tsx` — collapsible row with
  relative + absolute timestamp, type pill (colour-coded per
  `event_type` class), and a `payload` toggle that renders the
  formatted JSON on demand.
- `web/src/pages/ScalingTimelinePage.tsx` (replaces the stub) —
  useQuery against `/scaling/timeline`, 15m / 60m / 6h window toggle
  (same pattern as `ThroughputChart`), two panels: chart + events
  list.
- `web/src/components/scaling/SwimlaneChart.tsx` — recharts
  `ComposedChart` with four stacked `Area`s
  (ready / busy / provisioning / draining) sourced from
  `MetricSample.{ready,running,provisioning,draining}_vms`. Events
  are projected onto the closest sample row via a `marker` series so
  the chart shows a vertical dashed step where a scale event landed.
- `web/src/components/scaling/EventMarkerList.tsx` — newest-first
  scale-events table beside the chart with relative time + truncated
  payload summary on hover.
- `web/src/styles/audit.css` + `web/src/styles/scaling.css` —
  page-owned styles. **Kept out of `web/src/styles/app.css`** on
  purpose: a parallel session was actively editing `app.css` in the
  same working tree and its writes raced with mine, so each page now
  imports its own CSS to remove the collision risk.

Touched i18n (`web/src/lib/i18n.tsx`):

- Added `audit.payload.show`, `audit.payload.hide`, `scaling.chart.title`,
  `scaling.chart.meta`, `scaling.markers.title`, `scaling.markers.meta`,
  `scaling.markers.empty`, `scaling.empty` keys in both `en` and `ko`.
  All other `audit.*` and `scaling.*` keys were already added by the
  scaffold commit and are unchanged.

Touched `web/vite.config.ts`:

- Added `/events` and `/scaling/timeline` proxy entries pointing at
  `http://localhost:8800`. Both are API-only paths, so no SPA-route
  bypass is needed.

## Routes / nav

The scaffold commit already registered `/audit` and `/scaling` routes
in `web/src/main.tsx` and enabled the corresponding sidebar entries in
`web/src/components/AppShell.tsx`. **No edits to either file in this
change** — both stay untouched as the task spec requires.

## Verification

- `PYTHONPATH=src uv run pytest` → 58 passed.
- `cd web && npm test -- --run` → 4 passed.
- `cd web && npm run build` → success.
- `uv run ruff check src/rapid_evidence/spot/ src/rapid_evidence/api.py tests/test_api_events_scaling.py tests/test_spot_pool_manager.py` → all checks passed.
- Browser:
  - `/audit` — empty-state when the buffer is empty; once the pool
    runs, rows stream in (heartbeat/reconcile/pool_warmed/... visible),
    filter chips pick up unique types, no console errors.
  - `/scaling` — chart paints with stacked area on the first sample
    window (27+ samples observed locally), markers section shows
    correct empty state until the manager starts emitting
    `node_provisioned` / `scale_up` / etc. (future-session work).
  - No SPA navigation regressions on other pages.
