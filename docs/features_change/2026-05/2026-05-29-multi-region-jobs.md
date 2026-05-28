# Multi-region quota probe + background jobs + 24h scheduler

**Date:** 2026-05-29

## Why

The product spec calls out:

> 백엔드가 시작되면 Orchestrator 가 초기화 되면서 설정된 min spot vm,
> max spot vm 의 값을 확인 · 비동기로 Azure 모든 Region 에 대해 쿼터
> 조사를 하고 쿼터 부족한 Region 에 쿼터 증설 요청을 한다. 이 액션은
> 매 24시간 주기로 실행할 수 있어야 한다.

Until now the dashboard only saw the single region wired to
`AzureSpotVmConfig.location`, and any long-running internal work was
buried in `recent_events` rather than being a first-class user-visible
record. This change adds both.

## What landed

### `rapid_evidence/jobs/`

- `BackgroundJob` — `job_id` / `name` / `started_at` / `finished_at` /
  `status` / `result` / `error` / `metadata`.
- `BackgroundJobRegistry` — bounded ring buffer (default 100), thread
  + asyncio safe. `get()` / `list()` return *snapshots* so callers
  cannot mutate the registry's view.
- `run_tracked(registry, name, coro_factory)` — single wrapper for any
  long-running async work. Captures exceptions as `failed` jobs and
  propagates `CancelledError` after marking the job `cancelled`.

### `rapid_evidence/spot/regions.py`

- `probe_regions(regions=None, spot_quota_name=..., requested_per_region=...,
  max_parallelism=8, per_region_timeout_seconds=20)` — runs
  `az vm list-usage --location <region>` concurrently, capped at
  `max_parallelism` and with a per-region `asyncio.wait_for` + a hard
  `subprocess.run(timeout=...)` so a cancelled future does not leak
  the `az` child process.
- Defends against shell-meta injection by validating region names
  (`^[a-z][a-z0-9]{1,40}$`) and the spot quota name
  (`^[A-Za-z][A-Za-z0-9_-]{1,80}$`).
- Returns a `MultiRegionQuotaReport` with totals + sufficient /
  insufficient / failed buckets, fully JSON serialisable.
- `request_quota_increase(region, ...)` returns a
  `manual_action_required` plan with the exact `az support tickets
  create` command and the portal URL — `az` does not automate spot
  vCPU increases, so we surface the work instead of pretending.

### FastAPI

- `lifespan` builds a `BackgroundJobRegistry` and (when
  `RAPID_EVIDENCE_REGION_SCAN_INTERVAL_SECONDS > 0`, default 86400)
  starts `_region_scan_loop` which calls `probe_regions` inside
  `run_tracked` every interval. The first iteration is delayed via
  `RAPID_EVIDENCE_REGION_SCAN_INITIAL_DELAY_SECONDS` so startup is not
  blocked on `az`.
- New endpoints:
  - `GET /jobs?limit=…` — recent jobs (default 50)
  - `GET /jobs/{job_id}` — one job
  - `POST /quota/probe-regions` — on-demand scan; returns the finished
    `BackgroundJob`
  - `POST /quota/request-increase` — records the manual plan as a job
- `/dashboard/summary` and `/quota/status` are unchanged — the quota
  *refresh loop* added in session 3 still drives the single-region
  meter on the Quota page. The multi-region work is additive.

### Frontend

- `components/jobs/JobsPanel.tsx` — generic "Background jobs" panel
  rendered on the Quota page (other pages can drop it in too): a
  `scan now` button, hint line ("17 regions in parallel"), and an
  ordered table with status pills, timeAgo, duration, summary.
- `lib/api.ts`: `BackgroundJob`, `QuotaProbeRequest`,
  `QuotaIncreaseRequest`, `QuotaIncreaseResult` types and
  `jobsList` / `jobsGet` / `quotaProbeRegions` /
  `quotaRequestIncrease` clients.
- `lib/i18n.tsx`: full EN + KO keys under `jobs.*`.
- `vite.config.ts`: `/jobs` proxied to the backend.

## Verified live

Against the active `az login` (subscription
`ME-MngEnvMCAP132261-moonchoi-1`):

```
POST /quota/probe-regions {"regions":["koreacentral","japaneast","eastus"]}
→ finished in 2.0s
→ totals: limit=300 used=4 headroom=296
```

The automatic 24h scan kicked off 5 s after lifespan start and
returned a 17-region report (limit=1700, headroom=1696) in 8 s.

## Hardening cycle 1 fixes

1. `BackgroundJobRegistry.get()` / `list()` now return snapshot
   copies — callers cannot corrupt the registry's view.
2. `subprocess.run` in `_run_az_usage` now takes `timeout=` so a
   cancelled `asyncio.wait_for` cannot leak the `az` subprocess.
3. `probe_regions` and `request_quota_increase` reject region /
   quota-name strings that do not match the strict whitelist regex.
4. `JobsPanel` reads the last scan's `metadata.regions.length`
   instead of hard-coding 17.
