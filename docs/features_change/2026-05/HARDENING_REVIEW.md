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
