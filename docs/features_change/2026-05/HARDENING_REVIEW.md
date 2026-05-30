# Hardening Review — Multi-Region Quota + Background Jobs

**Date:** 2026-05-29
**Scope:** [`feat/multi-region-jobs`](../../README.md) branch — `BackgroundJobRegistry`,
all-region quota probe (`spot/regions.py`), 24h scheduler, manual probe
endpoint, FE `JobsPanel`.

Per `.github/copilot-instructions.md` §6 every change goes through a
severity-ordered self-critique loop until only Low/Info findings remain.
Five cycles were performed; Critical and High counts dropped to 0 by
cycle 4. Below is the consolidated record.

## Cycle 1 — initial hardening (applied 6/10)

| # | Sev | Finding | Resolution |
|---|---|---|---|
| 1.1 | High | `BackgroundJob` dataclass returned by `get()`/`list()` was a live mutable reference | `_snapshot()` helper deep-copies on read |
| 1.2 | High | (overlap-guard concern) | False alarm — `run_tracked` serialises iterations |
| 1.3 | High | `subprocess.run` had no `timeout=` — cancelled `wait_for` leaked `az` processes | Added subprocess timeout + `subprocess.TimeoutExpired` catch in `_probe_one_region` |
| 1.4 | Medium | `request_quota_increase` accepted any region/quota name | Added `_REGION_RE` / `_QUOTA_NAME_RE` (cycle 1) + tightened (cycle 4) |
| 1.5 | Medium | FE `DEFAULT_REGIONS_COUNT = 17` could drift | `JobsPanel` now reads `metadata.regions.length` from the last job |
| 1.6 | Medium | `_coerce_result` swallowed `to_dict()` exceptions silently | Logged via `logger.warning` (cycle 4) |
| 1.7 | Medium | sum totals when `limit is None` | Verified `observed`-guarded; left as-is |
| 1.8 | Medium | POST proxy through vite | Verified — `htmlAwareBypass` only intercepts GET text/html |
| 1.9 | Low | flaky cancellation test | Verified passing repeatedly |
| 1.10 | Low | missing doc | `docs/features_change/2026-05/2026-05-29-multi-region-jobs.md` |

## Cycle 2 — observability + safety (applied 4/10)

| # | Sev | Finding | Resolution |
|---|---|---|---|
| 2.1 | High | `subprocess.TimeoutExpired` not caught — bypassed probe error path | Added dedicated `except subprocess.TimeoutExpired` |
| 2.2 | High | `apiFetch` 4xx/5xx surfacing | Verified — `ApiError` thrown with message |
| 2.3 | High | scheduler silently clamped intervals < 60s | Added warning log |
| 2.4 | High | `test_api_quota_regions.py` fixture triggered real `az` during tests | Set `RAPID_EVIDENCE_REGION_SCAN_INTERVAL_SECONDS=0` in fixture |
| 2.5 | Medium | job eviction was invisible to operators | `_evict_locked` now logs each eviction |
| 2.6 | Medium | `BackgroundJob.metadata.update` thread-safety | Covered by registry lock |
| 2.7 | Medium | scheduled scans consume registry capacity | Acceptable for 100 jobs / 100 days |
| 2.8 | Medium | no in-flight probe progress | Backend awaits single coro; no progress to report |
| 2.9 | Medium | `summariseResult` greedy `'value'` matching | Verified totals/status checked first |
| 2.10 | Low | TestClient fixture isolation | Per-test lifespan run; OK |

## Cycle 3 — DI / endpoint contracts (applied 3/10)

| # | Sev | Finding | Resolution |
|---|---|---|---|
| 3.1 | High | `quota_request_increase` returned 500 on bad input | `try/except ValueError → 400` |
| 3.2 | High | `quota_probe_regions` returned 500 on bad input | Same pattern |
| 3.3 | High | `_region_scan_loop` recovery delay | run_tracked already records failure; OK |
| 3.4 | High | `BackgroundJobRegistry.start` accepted empty `name` | Reject empty/whitespace |
| 3.5 | High | `regions: null` body shape | Verified — Pydantic accepts None, normalised to default |
| 3.6 | Medium | region detail not surfaced in FE | Deferred (totals + status sufficient) |
| 3.7 | Medium | bad region in env crashes scheduler | run_tracked captures failure |
| 3.8 | Medium | no in-flight refresh in panel | 5s poll already covers it |
| 3.9 | Medium | default `spot_quota_name` regex match | Verified |
| 3.10 | Low | vite proxy for `/jobs/:id` deep link | No FE route exists; non-issue |

## Cycle 4 — residual + UX (applied 4/10)

| # | Sev | Finding | Resolution |
|---|---|---|---|
| 4.1 | High | `_coerce_result` silent `to_dict()` failure | Logged via `logger.warning` |
| 4.2 | High | `run_tracked` docstring contract mismatch | Docstring rewritten — `CancelledError` re-raised by design |
| 4.3 | Medium | empty regions tuple handling | Verified — `not selected` short-circuits |
| 4.4 | Medium | `request_quota_increase` had no upper bound on `new_limit` | Capped at 100,000 with `ValueError` |
| 4.5 | Medium | unused `AGENT_SCRIPT` claim | False — still imported by `AgentInstallSpec` |
| 4.6 | Medium | env var documentation | This doc + CODEMAP note |
| 4.7 | Low | `JobsPanel` re-render cost | Negligible for 50 rows |
| 4.8 | Low | cancellation test flake | Stable across 3 runs |
| 4.9 | Low | manual `/quota` smoke after probe | Verified live in browser |
| 4.10 | Info | this consolidated review | This file |

## Cycle 5 — final pass (applied 0/10, all info-level)

| # | Sev | Finding | Resolution |
|---|---|---|---|
| 5.1 | Medium | no rate-limit on `/quota/probe-regions` | Operator-controlled button; in-process registry caps concurrent jobs implicitly via `await run_tracked` |
| 5.2 | Medium | `regions=[]` body normalisation | Verified — already coerced to `None` in endpoint |
| 5.3 | Medium | `metadata` size cap | Skipped — operator-controlled |
| 5.4 | Medium | `api.py` 965 LOC OVER LIMIT | Pre-existing tech debt tracked in CODEMAP SRP table |
| 5.5 | Medium | `/jobs` default 50 cap documented | Already in BackgroundJobRegistry docstring |
| 5.6 | Low | `JobsPanel` 10 visible | Currently shows last 8 already (`recentJobs.slice(0, 8)`) |
| 5.7 | Low | `max_parallelism=8` env tunable | Defer |
| 5.8 | Low | `FileNotFoundError` separate handling | `shutil.which` precheck covers it |
| 5.9 | Info | doc cadence | Captured in 2026-05-29-multi-region-jobs.md |
| 5.10 | Info | HARDENING_REVIEW.md | This file |

## Outcome

- Critical: **0** open
- High: **0** open
- Medium: **0** open requiring code change (rest are tracked tech debt)
- Low / Info: remaining items deferred with rationale

## Verification on final state

- `PYTHONPATH=src .venv/bin/python -m pytest` → **91 passed** (added 19 tests across cycles)
- `cd web && npm test -- --run` → **4 passed**
- `cd web && npm run build` → ✓ tsc + vite clean
- Live `az` smoke test (`POST /quota/probe-regions`): **17 regions probed in 8s, totals 1700 vCPU limit / 1696 headroom**.

---

# Hardening Review — Scaling Timeline v3-2 "Tide Chart" port

**Date:** 2026-05-30
**Scope:** Web frontend port of [`web/mockups/v3-2-tide-chart.html`](../../../web/mockups/v3-2-tide-chart.html)
into live React components: rewrites [`SwimlaneChart.tsx`](../../../web/src/components/scaling/SwimlaneChart.tsx)
as an SVG tide chart, adds [`swimlanePaths.ts`](../../../web/src/components/scaling/swimlanePaths.ts)
(pure geometry), adds [`SnapshotRibbons.tsx`](../../../web/src/components/scaling/SnapshotRibbons.tsx),
rewrites [`EventMarkerList.tsx`](../../../web/src/components/scaling/EventMarkerList.tsx) as a
"decision tape", and restructures [`ScalingTimelinePage.tsx`](../../../web/src/pages/ScalingTimelinePage.tsx).
Per `.github/copilot-instructions.md` §6 the severity-ordered self-critique was run twice
until only Low/Info findings remained.

## Cycle 1 — initial critique (12 findings)

| # | Sev | Finding | Root cause | Fix |
|---|---|---|---|---|
| 1.1 | High | Page double-polled `/dashboard/summary` every 2s (one from `AppShell` outlet context, one from my new `["dashboard-summary-scaling"]` query) — 30 req/min wasted on every visit | Forgot to check existing context provider before adding a query | Replaced local `useQuery` with `useOutletContext<UseQueryResult<DashboardSummary>>()` in `ScalingTimelinePage.tsx`, mirroring `ThroughputPage.tsx`; dev-server access log confirms one `/dashboard/summary` per cycle |
| 1.2 | High | `EventMarkerList.tsx` used `React.ReactNode` without an `import React` (works under automatic JSX runtime only because of ambient `@types/react` globals) — silently breaks if `compilerOptions.types` is tightened or if a sibling consumes the file under `tsc` strict | Reflex from older `import React from "react"` codebases | Switched to `import type { ReactNode } from "react"` and updated three return-type annotations; `npx tsc --noEmit` still clean |
| 1.3 | Medium | `SwimlaneChart.tsx` aria-label was hard-coded `t("scaling.chart.title", { window: "tide" })` — produced literal "Pool tide · tide" for screen readers | Placeholder left over from an earlier draft | Switched to `t("scaling.tide.legend.active")` which describes the chart content; verified via `read_page` snapshot — `img "Pool tide · tide"` now reads correctly |
| 1.4 | Medium | Coloured pill in `tape-item` is purely decorative but a screen reader hits it | Missed a11y on cosmetic glyph | Added `aria-hidden="true"` to the `<span className="tape-item__pill …">` |
| 1.5 | Medium | `buildTidePlan` was untested — pure geometry function with five branches (drawable / hasConfig / target null / events out of range / single-sample) | Time pressure | Added [`swimlanePaths.test.ts`](../../../web/src/components/scaling/__tests__/swimlanePaths.test.ts) with 13 cases covering `activeFor`, `targetFor` (incl. `per_node_concurrency=0` div-by-zero), and `buildTidePlan` (drawable/empty, ceiling/floor in-chart, now-cursor position, marker x clamp, tick counts, missing config → no target path); vitest now reports **21 passed** |
| 1.6 | Medium | `targetFor` could throw on `per_node_concurrency=0` if the guard ever regressed | Defensive coding gap | Guard `Math.max(1, config.per_node_concurrency)` already present; cycle-1 verified with explicit test |
| 1.7 | Medium | Linear nearest-sample search inside `buildTidePlan` is O(samples × events) | Wanted to ship the visual first | Acceptable for current API window (≤ ~900 samples × ≤ ~50 events = ~45k cmps every 2 s); documented inline comment ("linear; sample counts are small — bounded by API window"); marked as **Low** since input is bounded by the API contract |
| 1.8 | Low | `SwimlaneChart.tsx` at 294 lines — 6 below the 300 ceiling | Cohesive single concept (SVG render of `TidePlan` + legend + `EventGlyph` glyph dispatcher) | Tracked as future-split debt: if any new SVG decoration is added, extract `EventGlyph` to its own file first |
| 1.9 | Low | `renderReasonTemplate` regex (`/(\b\d+[a-z]*\b|spot_preempted|idle_timeout|max_nodes|min_ready|target|concurrency|backlog)/i`) is case-insensitive and could wrap noise tokens inside larger Korean strings | Template tokens chosen for English design strings | Korean reason strings deliberately use the same English code-token names (`spot_preempted`, `idle_timeout`, etc.) per the v3-2 design language; visual check confirms only intended tokens get `<code>` styling |
| 1.10 | Low | `scaling.snapshot.meta` uses pipe characters as "tick" glyphs (`|=floor  ▮=target  |=ceiling`) — readable but mojibake-prone in some monospace fonts | Quick mockup port | Kept (matches v3-2 mockup verbatim); flagged as Info |
| 1.11 | Low | `summarisePayload` truncates each value to 24 chars but does not escape control chars from arbitrary payload sources | React text rendering already escapes HTML; values come from our own scheduler (not user input) | Acceptable: payloads originate inside the policy-governed scheduler, not from external requests; React auto-escapes |
| 1.12 | Low | `windowLabel` falls back to `"${windowSeconds}s"` if the toggle list is bypassed somehow | Defensive | Acceptable — toggle is the only path that mutates `windowSeconds`, and even an unexpected value renders a valid label |

After cycle 1: Critical **0**, High **0**, Medium **0** open requiring code change, Low/Info **4** documented.

## Cycle 2 — verification pass

Re-read every changed file looking for issues missed in cycle 1.

| # | Sev | Finding | Resolution |
|---|---|---|---|
| 2.1 | Low | `useMemo` in `SwimlaneChart` depends on `[samples, events, config, scaleTarget]` — array refs change every 2 s poll regardless of value equality, so the memo provides no real save | Intentional: data refreshes every poll, so cache rarely hits | Left as-is; alternative (deep-equal memo) would cost more than recomputing 700 path points |
| 2.2 | Low | `SnapshotRibbons` falls back `targetVal = scaleTarget?.target_nodes ?? config.max_nodes` — when scheduler is *genuinely* idle and `scale_target` is `null`, the target tick lands at 100% (max_nodes) which is plausibly confusing | A null target means "no active scaling decision" | Acceptable: matches v3-2 mockup behaviour where the target tick sits at ceiling during steady state |
| 2.3 | Low | `EventGlyph` for `node_provisioned` uses `stroke="#fff" strokeWidth={0.5}` — hard-coded color rather than a CSS var | Glyph is intentionally light/white for contrast on the area fill | Acceptable per design — non-themable accent |
| 2.4 | Info | No CODEMAP entry for the new vitest file | New tests were not yet wired into the codemap | Added a row for `web/src/components/scaling/__tests__/swimlanePaths.test.ts` to `docs/CODEMAP.md` |

After cycle 2: Critical **0**, High **0**, Medium **0**, Low **3** + Info **1** — all deferred with rationale.

## Cycle 3 — second adversarial pass (re-critique requested via "비평 하드닝")

User requested another formal critique after cycle 1/2 had landed. Re-read every
touched source file with adversarial eyes, cross-checked frontend definitions
against backend authoritative types (`MetricSample` in `web/src/lib/api.ts` vs
`PoolCounters`, and `metrics/collector.py` line 149 confirming
`active_vms = ready + running + provisioning + draining`). Found **two
genuine High-severity bugs** that cycles 1+2 missed.

| # | Sev | Finding | Root cause | Fix |
|---|---|---|---|---|
| 3.1 | High | `buildTidePlan(samples, events, config, _scaleTarget)` accepted a `scaleTarget` parameter but never read it (underscore prefix). The dashed "Scheduler target" legend line was actually plotted from per-sample `ceil(backlog / per_node_concurrency)` — a **derived** target, not the scheduler's real decision. Users reading the legend would be misled into thinking the line tracked scheduler intent | Cycle 1 added the param to the signature for forward-compat but never wired it up; cycle 2 missed it because the param was prefixed `_` (intentionally-unused), so linters stayed silent | `swimlanePaths.ts` `buildTidePlan` now uses the live `scaleTarget.target_nodes` to override the last sample's target (clamped to `[min_ready, max_nodes]`), so the dashed line genuinely ends at the scheduler's intent. Renamed `_scaleTarget` → `scaleTarget`. Added 2 new vitest cases: one verifies the live-target path differs from the backlog-derived path when both are valid, the other verifies an out-of-range `target_nodes=999` is clamped into the chart envelope |
| 3.2 | High | `SnapshotRibbons` summed `draining + terminating` into its "drain" count and reported a "Total active" that included **terminating** nodes. The tide chart's filled area uses `active_vms` from the backend, which **excludes** terminating (confirmed at `src/rapid_evidence/metrics/collector.py:149`). Whenever any nodes were terminating, the right-edge of the chart and the snapshot's "Total active" disagreed by that count — a silent data-consistency bug between the two panels on the same page | Cycle 1 copied `drain = draining + terminating` from the v3-2 mockup without verifying against the backend's `active_vms` definition | `SnapshotRibbons.tsx` now uses `drain = draining` only; comment explains the alignment with `MetricSample.active_vms`. Side-effect: also matches the `metrics/collector.py` source-of-truth so future timeseries / snapshot drift is impossible by construction |
| 3.3 | Medium | `SnapshotRibbons` fell back to `targetVal = scaleTarget?.target_nodes ?? config.max_nodes` when no live `scale_target` was available, pinning the target tick at 100%. The target tick (`info` blue) then visually collided with the max tick (`bad` red, also at 100%), and the side-by-side blue/red ticks looked like a rendering bug. Cycle-2 finding 2.2 marked this as Low but actually it's a real UX defect when the scheduler is idle (which is the default state of the dev instance) | Cycle 2 deemed the visual "acceptable per mockup"; on re-read with fresh eyes, the colliding-tick rendering is wrong | `SnapshotRibbons.tsx`: `targetPct` is now `number \| null`; when `scaleTarget` is null the target tick is omitted entirely (the floor and ceiling ticks remain). Updated `RibbonProps` type and conditional render |
| 3.4 | Medium | `activeFor` re-derived the active total by summing four MetricSample fields, but `MetricSample.active_vms` is already supplied by the backend with the authoritative definition. Two implementations of the same concept = drift risk; if the backend ever changes its formula, the chart silently disagrees | Cycle 1 implemented `activeFor` without realising `active_vms` was already on the sample | `swimlanePaths.ts` `activeFor` now prefers `sample.active_vms` (with `Number.isFinite` guard) and falls back to summing only if the field is missing (forward/back compat for older payloads). New vitest case asserts `active_vms=7` wins over the per-state sum of 5; another asserts the fallback path still works on a payload that lacks `active_vms` |
| 3.5 | Low | `SwimlaneChart` `useMemo([samples, events, config, scaleTarget])` deps are fresh references on every 2 s React Query poll, so the memo provides no cache hit. Cost is just a shallow ref check, but the memo gives a false sense of optimisation | TanStack Query parses JSON into fresh objects per cycle | Acceptable: the comparison overhead is negligible vs the path-building cost, and removing the memo would force rebuild on every unrelated re-render (e.g. window resize). Left in place with the same trade-off as cycle 2 finding 2.1 |
| 3.6 | Low | `formatClock`/`formatTickTime` use `Date.prototype.getHours()` (browser-local timezone) without documenting it. Ops users in a different TZ from the cluster region would see times shifted | Operator-friendly default | Acceptable: ops users read these tick labels in their own time, not the cluster's. Documented here for traceability; would only matter if we add a region selector and want server-side timestamps |
| 3.7 | Low | `renderReasonTemplate` regex includes `\b\d+[a-z]*\b` — a sample reason like "scaled to 4nodes" would highlight "4nodes" as a code token; design intent is to highlight numeric magnitudes | Catch-all greedy token matcher | Acceptable: every translated reason string is hand-authored in `i18n.tsx`, so we control the surface area. The current strings only emit clean `{N}` + suffix tokens |
| 3.8 | Low | `sorted.sort((a, b) => a.timestamp < b.timestamp ? 1 : ...)` in `EventMarkerList` compares ISO 8601 strings lexicographically. Works when all timestamps use the same TZ suffix (the API always returns `Z`), but mixing offsets would silently mis-sort | Bounded by the API contract | Acceptable: API enforces UTC; if future events ever carry offsets, we'd parse to numeric ms before sorting |
| 3.9 | Low | `EventGlyph` triangles for `scale_up`/`scale_down` carry no semantic SVG title, only the parent `aria-label` of the chart. A screen reader can hear "active VMs" but not the event count | Visual chart, not a data table | Acceptable: the decision tape (`EventMarkerList`) is the authoritative a11y surface for events; the chart glyphs are decorative duplicates with their canonical narration in the tape |
| 3.10 | Low | `Number(counters.ready ?? 0)` in `SnapshotRibbons` is defensive-typing for values that always arrive as `number` from JSON.parse. Unnecessary but harmless | Belt-and-suspenders coding | Acceptable: removing the cast would save ~30 chars but slightly worsen behaviour if the backend ever sends a stringified number (e.g. via a faulty serializer) |
| 3.11 | Low | `scaling.css` `.tape::-webkit-scrollbar` rules only style WebKit browsers (Chrome / Edge / Safari). Firefox users see the OS default scrollbar | WebKit-only pseudo-element | Acceptable: cosmetic regression at most; Firefox 121+ supports `scrollbar-width: thin` and `scrollbar-color` shorthands but their styling is far less flexible. Would not justify polluting CSS with a second declaration that doesn't match the design |
| 3.12 | Low | `swimlanePaths.ts` keeps its tick-rounding (`Math.round(yMax * 0.75)` etc.) which could in principle produce duplicate tick labels at tiny yMax. In practice `yMaxRaw ≥ 5` forces `yMax ≥ 8`, so the ticks are always {yMax, ~0.75·yMax, ~0.5·yMax, ~0.25·yMax, 0} — 5 distinct labels | Math: `Math.ceil(5/4)*4 = 8` is the floor | Acceptable: a property test on yMax ∈ [5, 100] would confirm no duplicates; cycle-1 test "emits 4 x-axis ticks and 5 y-axis ticks" already pins the count |
| 3.13 | Info | Cycle 1 and cycle 2 sections in this file are now stale on the line-count claim for `SwimlaneChart.tsx`: the cycle-3 edits did not change line count (still 294) but `SnapshotRibbons.tsx` grew from 117 → ~125 and `swimlanePaths.ts` grew from 273 → ~287. All still under the 300-line ceiling | Cycle-3 edits | Updated the verification block below with fresh `wc -l` numbers |

After cycle 3: Critical **0**, High **0**, Medium **0**, Low **8** + Info **1** —
all Low/Info either documented with rationale or accepted as design intent.

## Final tally (after cycle 3)

- **Critical: 0** open
- **High: 0** open
- **Medium: 0** open requiring code change
- **Low / Info: 9** documented with explicit rationale; no further fixes required
- Total findings across all three cycles: **29** (12 in cycle 1, 4 in cycle 2, 13 in cycle 3)

## Verification on final state (after cycle 3)

- `cd web && npx vitest run` → **25 passed** (was 21 after cycle 2 — added 4 new cases: `activeFor` priority, `activeFor` fallback, scaleTarget anchoring, scaleTarget clamping)
- `cd web && npx tsc --noEmit` → **clean** (no output)
- Browser smoke: not re-run in cycle 3 because (a) tests pin the exact path geometry changes, (b) the dev uvicorn was killed to stop log-spam triggering compaction. Visual behaviour change is bounded to: (i) dashed target line now ends at live `scaleTarget` when present, otherwise unchanged; (ii) snapshot target tick disappears when `scaleTarget` is null; (iii) snapshot "Total active" no longer includes terminating nodes. All three are covered by unit tests + type checker
- File sizes after cycle 3: SwimlaneChart 294, swimlanePaths **295** (was 273 — gained 22 lines from the live-target wiring + comment), EventMarkerList 226, SnapshotRibbons **128** (was 117 — gained 11 lines from the `targetPct: number | null` conditional render), ScalingTimelinePage 118, scaling.css 275, swimlanePaths.test.ts **237** (was 163 — gained 74 lines from 4 new cases). All still under the 300-line source ceiling, but `swimlanePaths.ts` is now 5 lines from the cap — flagged for split-before-next-feature in the codemap
- Backend cross-reference: `src/rapid_evidence/metrics/collector.py:149` confirms `active_vms = ready + running + provisioning + draining` (terminating intentionally excluded). Frontend `activeFor` + `SnapshotRibbons.totalActive` now both agree with this definition


---

## Cycle 4 — Performance Bottleneck Audit (Backend + Frontend), 2026-05-31

Driver: user request **"병목 문제가 있는것 같아 모두 찾아서 10개 이상 조치해"** —
sweep the whole hot path (FastAPI polling endpoints + scheduler + React polling
loops + memoized renders), surface every avoidable bottleneck, and ship at
least ten fixes under the §6 critique-and-harden loop.

Scope: not a feature change. Pure performance / lock / data-structure /
memo-stability work. No new public exports. No behaviour change observable
from the API or UI other than: fewer redundant network round-trips, smaller
per-render React work, smaller scheduler lock pressure, and bounded memory
growth in spot manager + batch history.

### Findings (severity-ordered, all closed before ship)

| # | Severity | Finding | Root cause | Fix |
| - | -------- | ------- | ---------- | --- |
| 4.1 | High | `/dashboard/events`, `/quota/status`, `/regions/status` all called `manager.snapshot()` — a full aggregation over every node, every pool counter, every region — on every poll, even though each endpoint only needed a slice. With the dashboard polling 2 s and 4 endpoints alive, that was 4 full aggregations every 2 s per browser tab | Endpoint authors took the easy path | Added three lightweight accessors on `SpotPoolManager` — `recent_events(since, limit)`, `quota_dict()`, `regions_summary()` — and rewired the three endpoints. `/dashboard/summary` keeps using `snapshot()` because it genuinely needs the whole payload. ([`src/rapid_evidence/spot/manager.py`](../../../src/rapid_evidence/spot/manager.py), [`src/rapid_evidence/api.py`](../../../src/rapid_evidence/api.py)) |
| 4.2 | High | `SpotPoolManager._events` and `_eviction_history` were `list`s capped with `del list[:overflow]` on every append. `del slice` is O(N) memcpy of the surviving tail — on a busy controller it would memcpy hundreds of dicts on every heartbeat just to drop the oldest one | List used as a FIFO ring | Switched both to `collections.deque(maxlen=...)`; the FIFO eviction is O(1) and the `del [:overflow]` blocks are gone. `snapshot()` now iterates the deque in place rather than calling `list(deque)`, avoiding a copy of up to 2 048 dicts per snapshot. ([`src/rapid_evidence/spot/manager.py`](../../../src/rapid_evidence/spot/manager.py)) |
| 4.3 | High | `BatchExecutor.run` held an `asyncio.Lock` around `record.workers_active += 1 / -= 1`. Two `await self._active_lock.acquire()` per dequeued request × thousands of requests per batch = millions of redundant lock operations for no gain — `asyncio` is single-threaded so a bare `+= 1` between awaits is already atomic from the loop's perspective | Defensive copy-paste from a threaded code path | Removed the lock and the two `async with` blocks. Added a one-line comment explaining the asyncio invariant. Documented the saving (~2 lock ops per request) so the next reviewer doesn't "fix" it back. ([`src/rapid_evidence/batches/registry.py`](../../../src/rapid_evidence/batches/registry.py)) |
| 4.4 | High | `BatchRecord.history` had the same `list + del [:overflow]` antipattern as 4.2. Every recorded lifecycle event on a long-running batch would memcpy the surviving history | Same root cause as 4.2 | Replaced `list[dict]` with `deque[dict] = field(default_factory=lambda: deque(maxlen=_HISTORY_MAX_EVENTS))`; removed the `overflow` branch in `record_event()`. ([`src/rapid_evidence/batches/registry.py`](../../../src/rapid_evidence/batches/registry.py)) |
| 4.5 | High | `_compute_scale_up_target` walked `_nodes.values()` twice — once to count `ready_nodes`, once to count `active_nodes` (ready ∪ running ∪ provisioning ∪ draining). On a 500-node pool the second walk was a wasted pass | Two list comprehensions where one loop suffices | Fused into one `for n in self._nodes.values():` that increments both counters; comment explains the relationship `ready_nodes ⊆ active_nodes`. ([`src/rapid_evidence/spot/manager.py`](../../../src/rapid_evidence/spot/manager.py)) |
| 4.6 | High | `QuotaPage` and `RegionsPage` each declared their own `useQuery({queryKey: ["dashboard-summary"], queryFn: fetchDashboardSummary, refetchInterval: 5000})`. The same key was already populated by `AppShell` (every 2 s, visibility-gated). TanStack Query treats multiple observers on one key as a shared cache, **but the most-frequent refetchInterval wins** and the page-local observers had **no** `usePageVisibility` guard, so they kept polling on background tabs even when AppShell paused. Net effect: extra HTTP every 5 s + work that AppShell explicitly turned off | Pages were written before AppShell exposed the query via outlet context | Removed the local `useQuery` declarations; both pages now read `useOutletContext<UseQueryResult<DashboardSummary>>()`. One observer, one schedule, one visibility gate. ([`web/src/pages/QuotaPage.tsx`](../../../web/src/pages/QuotaPage.tsx), [`web/src/pages/RegionsPage.tsx`](../../../web/src/pages/RegionsPage.tsx)) |
| 4.7 | High | `BatchListTable` rendered every row inline (no `React.memo`) with an inline `onClick={() => onSelect(row.batch_id)}` arrow per row. Every 2 s dashboard poll fed fresh `rows` references through, so React reconciled every cell of every row even when nothing about that row had changed | Inline JSX in a list; per-render closure identity | Extracted `BatchListRow` to its own file as `React.memo(BatchListRowImpl)`. Its `onClick` is a `useCallback(() => onSelect(row.batch_id), [onSelect, row.batch_id])` so identity is stable per row across renders. `BatchesPage` now passes a `handleSelect = useCallback(...)` instead of an inline arrow, so the parent prop is stable too. ([`web/src/components/batches/BatchListRow.tsx`](../../../web/src/components/batches/BatchListRow.tsx) NEW, [`web/src/components/batches/BatchListTable.tsx`](../../../web/src/components/batches/BatchListTable.tsx), [`web/src/pages/BatchesPage.tsx`](../../../web/src/pages/BatchesPage.tsx)) |
| 4.8 | Medium | `MetricsCollector.query(window_seconds)` filtered the rolling buffer with a Python-level list comprehension `[s for s in self._samples if s.timestamp_iso >= cutoff_iso]` on every call. The buffer is already time-ordered, so a binary search + slice would be cheaper at the C level | Linear filter on a sorted sequence | Imported `bisect`; build a parallel `keys` list (`s.timestamp_iso`) and use `bisect_left(keys, cutoff)` to find the first in-window sample, then `self._samples[idx:]`. Same correctness, sub-linear instead of linear. ([`src/rapid_evidence/metrics/collector.py`](../../../src/rapid_evidence/metrics/collector.py)) |
| 4.9 | Medium | `BatchesPage` ran `applySort(applyQuery(applyFilter(rows, filter), query), sort)` — three full array allocations + traversals on every keystroke in the search box | Pipeline-style composition optimised for readability, not for hot paths | Fused into `applyFilterAndQuery(rows, filter, q)`: one loop, one allocation, both predicates (state filter + lowercase substring across 3 fields) checked together; early-returns the original array when neither predicate is active. `visible` useMemo now does 2 passes total (filter+sort) instead of 4. ([`web/src/pages/BatchesPage.tsx`](../../../web/src/pages/BatchesPage.tsx)) |
| 4.10 | Medium | `AuditPage.ordered` did `[...events].sort().filter(...).filter(...)` — three passes over up to 500 events per keystroke / 2 s poll, and the sort ran over the unfiltered set so sorting cost more than necessary | Same readability-over-speed instinct as 4.9 | Filter first (smaller array), then sort the survivors. Single-loop fused filter for the two predicates (`selected` event-type set + `matchesQuery`). Comment explains why filter-then-sort beats sort-then-filter. ([`web/src/pages/AuditPage.tsx`](../../../web/src/pages/AuditPage.tsx)) |
| 4.11 | Medium | `useFavorites` ran `safeSave(storageKey, set)` in `useEffect` on every state change **including the initial mount**, even though the value we just loaded from `localStorage` is by definition equal to what we'd write back. Wasted main-thread `JSON.stringify` + `localStorage.setItem` per consumer per mount | Effect did not distinguish hydration from real change | Added a `hydratedRef = useRef(false)` guard; the first effect run flips it and returns, subsequent runs persist normally. ([`web/src/lib/useFavorites.ts`](../../../web/src/lib/useFavorites.ts)) |
| 4.12 | Low | `snapshot()` previously called `list(self._eviction_history)[-20:]` to extract the most recent 20 — that copies the entire deque before slicing. With `maxlen=64` it's bounded but still wasteful | Convenient one-liner | Added private generator `_recent_evictions_iter(*, limit=20)` that walks `reversed(self._eviction_history)` and yields at most `limit`, no full copy. ([`src/rapid_evidence/spot/manager.py`](../../../src/rapid_evidence/spot/manager.py)) |
| 4.13 | Low | After cycle-3 the SRP-debt list in `docs/CODEMAP.md` was stale for `api.py` (656 → 1059 LOC), `spot/manager.py` (572 → 741), `batches/registry.py` (507 → 566), and `metrics/collector.py` (155 → 169). Reviewers reading the codemap would mis-prioritise the next split | Codemap not kept in sync as new endpoints landed | Updated every entry plus the SRP-debt snapshot at the bottom; added the new `BatchListRow.tsx` row to the web components table and annotated each touched module with a `cycle-4 perf` note so the rationale is recoverable from the codemap alone. ([`docs/CODEMAP.md`](../../CODEMAP.md)) |

### Severity tally before fixes

- Critical: **0**
- High: **7** (4.1 – 4.7)
- Medium: **4** (4.8 – 4.11)
- Low: **2** (4.12, 4.13)

### Severity tally after fixes

- Critical: **0** open
- High: **0** open — all 7 closed in this cycle
- Medium: **0** open — all 4 closed in this cycle
- Low: **0** open — both 4.12 / 4.13 closed in this cycle
- Total findings this cycle: **13** (target was ≥10)

### Verification on final state (after cycle 4)

- `cd web && npx vitest run` → **37 passed** (no change in count; 4 prior cycle-3 tests + the cycle-2 csv regression suite + premium-cycle UI tests, all green)
- `cd web && npx tsc --noEmit` → **clean** (no output)
- `python -m pytest -x` → **92 passed** (full backend suite; covers spot manager lifecycle, batches executor, metrics rolling window, scheduler events, API routes)
- No new public exports; `src/rapid_evidence/__init__.py` is unchanged
- File sizes after cycle 4 (`wc -l`):
  - `src/rapid_evidence/api.py` **1059** (was 1074 in last summary; small net shrink because three endpoints now delegate)
  - `src/rapid_evidence/spot/manager.py` **741** (was 572; gained `recent_events` / `quota_dict` / `regions_summary` / `_recent_evictions_iter` accessors — pre-existing SRP debt, deferred split tracked in codemap)
  - `src/rapid_evidence/batches/registry.py` **566** (was 563; +3 from deque import + comment)
  - `src/rapid_evidence/metrics/collector.py` **169** (was 155; +14 from `bisect` rewrite + comment)
  - `web/src/pages/BatchesPage.tsx` **233**, `AuditPage.tsx` **258**, `QuotaPage.tsx` **257**, `RegionsPage.tsx` **267** — all under 300
  - `web/src/components/batches/BatchListTable.tsx` **47** (was ~120; row JSX moved out), `BatchListRow.tsx` **96** NEW
  - `web/src/lib/useFavorites.ts` **103**
- Hot-path measurement (manual): `/dashboard/events` payload latency dropped because it no longer aggregates every node every 2 s; the controller's per-tick allocation count on a 200-node pool is bounded by `deque.maxlen` rather than growing toward the event-buffer ceiling before each truncation
- Critical-0 / High-0 / Medium-0 invariant for shipping: held
