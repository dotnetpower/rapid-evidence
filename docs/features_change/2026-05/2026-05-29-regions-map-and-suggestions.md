# 2026-05-29 — Regions world map + quota-increase suggestions + jobs in status bar

## Scope

Three additions on `main` (no separate branch, no merge) following the
hardening pass after the multi-region quota work landed.

## 1. World map for the Regions page

- **New**: `web/src/components/regions/regionGeo.ts` — lat/lon catalog
  for the 30+ Azure public regions the dashboard tracks. Pure data;
  no business logic depends on it (missing entry just hides the
  marker, the card view still works).
- **New**: `web/src/components/regions/RegionsMap.tsx` — `react-leaflet`
  `MapContainer` with dark CARTO tiles, one `CircleMarker` per region
  with colour by status (busy/ready/capacity/exhausted/error/unknown)
  and a tooltip showing node counts, eviction count, and last quota
  probe.
- **Updated**: `web/src/pages/RegionsPage.tsx` now has a `map ↔ cards`
  toggle (defaults to map). Map view binds the latest
  `azure-region-quota-scan` job's per-region result into the marker
  colours so an all-region scan visibly fills in headroom on the map.
- **New deps**: `leaflet`, `react-leaflet`, `@types/leaflet` (installed
  with `--legacy-peer-deps` for React 19 peer ranges).
- **New i18n keys**: `regions.map.*` (en + ko).
- **Bundle hygiene**: `main.tsx` now `lazy()`-loads `RegionsPage` with
  a `Suspense` fallback so leaflet (~150 KB gzip) only ships when the
  user opens that route. Result: main bundle 910 KB → 745 KB,
  RegionsPage chunk 165 KB / CSS 15 KB.

## 2. Automatic quota-increase suggestion jobs

- **Updated**: `src/rapid_evidence/api.py::_region_scan_loop`. After
  every 24-hour scan, the new helper
  `_emit_quota_increase_suggestions` walks
  `MultiRegionQuotaReport.insufficient_regions` and opens one
  `quota-increase-suggestion-{region}` job per region with:
  - `metadata.current_used` / `current_limit` from the probe,
  - `metadata.suggested_new_limit` = `max(limit*2, limit+8)`, clamped
    to the 100,000 cap that `request_quota_increase` already enforces,
  - `metadata.trigger = "periodic-region-scan"`,
  - `result` set to the structured manual-action plan that
    `request_quota_increase` returns.
- Azure does not let `az` submit spot vCPU support tickets directly,
  so the job remains advisory — but the operator now sees an
  actionable row on the dashboard instead of digging through the scan
  payload.
- **New test**: `tests/test_api_jobs_regions.py::
  test_emit_quota_increase_suggestions_records_one_job_per_insufficient_region`.

## 3. Status-bar visibility for background jobs

- **Updated**: `web/src/components/AppShell.tsx` polls `/jobs?limit=50`
  every 5 s and renders a new `⚙ jobs N` segment in the bottom status
  bar. When the last 10 jobs contain failures the segment also shows a
  red `· N failed` suffix.
- **New i18n keys**: `bar.jobs`, `bar.jobsTooltip`, `bar.failed`.
- Closes the requirement that *every* page (not just `/quota`) must
  expose the "currently running background jobs" surface.

## 4. Smaller fixes (rolled in)

- `InMemorySpotVmProvider` tags new nodes with
  `metadata.region = "local"` so the Regions endpoint groups them
  under a real bucket instead of `(unknown)`.
- `ThroughputPage` "spot vm" KPI value now renders
  `"{active} / {target} / {max}"` in a single value field (no more
  awkward `"0/ — / —"` spacing).
- `RegionsMap`'s auto-fit-to-content now runs **once** per mount via
  a `useRef` guard — previously every 5-second poll snapped the map
  back to its default zoom, fighting any user pan/zoom.

## Verification

- `PYTHONPATH=src .venv/bin/python -m pytest` → **92 passed**.
- `cd web && npm test -- --run` → 4 passed.
- `cd web && npm run build` → tsc + vite clean. Code split visible
  (RegionsPage as its own JS + CSS chunk).
- Browser smoke: `/regions` shows the map with 17 markers in tooltip
  range; `/quota` JobsPanel still works; bottom status bar shows
  `⚙ jobs 0` after the boot scan completes.

## Affected files

- New: `web/src/components/regions/RegionsMap.tsx`,
  `web/src/components/regions/regionGeo.ts`,
  `docs/features_change/2026-05/2026-05-29-regions-map-and-suggestions.md`.
- Updated: `web/src/pages/RegionsPage.tsx`, `web/src/main.tsx`,
  `web/src/components/AppShell.tsx`, `web/src/lib/i18n.tsx`,
  `web/src/styles/quota-regions.css`, `web/src/pages/ThroughputPage.tsx`,
  `src/rapid_evidence/api.py`, `src/rapid_evidence/spot/fake.py`,
  `tests/test_api_jobs_regions.py`, `web/package.json`,
  `web/package-lock.json`.
