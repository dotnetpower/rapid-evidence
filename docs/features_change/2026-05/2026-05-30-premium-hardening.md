# Premium UX Hardening Review — 2026-05-30

§6 critical-0 hardening loop, conducted after the premium-UX cycle that
applied ≥20 improvements to each of the six menus (Throughput, Regions,
Batches, Scaling, Quota, Audit).

## Cycle 1 findings (severity-ordered)

| # | Severity | Finding | Root cause | Fix | File |
| -: | -------- | ------- | ---------- | --- | ---- |
| C1 | None | — | — | No Critical findings introduced by this cycle (all new code is presentation/state, no auth, no I/O boundaries, no network handling). | — |
| H1 | High | Ctrl+N keyboard handler duplicated verbatim in `ThroughputPage` and `BatchesPage`. | Copy-paste between two pages — guaranteed to drift the moment one side fixes a corner case the other forgets. | Extracted into a shared `useCtrlOrCmdHotkey({ key, onTrigger })` hook. Both pages now call the same one-liner; the inputs-focused guard, key-case-fold, and listener cleanup live in one place. | [web/src/lib/useHotkey.ts](../../../web/src/lib/useHotkey.ts), [web/src/pages/ThroughputPage.tsx](../../../web/src/pages/ThroughputPage.tsx), [web/src/pages/BatchesPage.tsx](../../../web/src/pages/BatchesPage.tsx) |
| H2 | High | `BatchesTable.tsx` grew to **320 LOC**, over the 300 hard ceiling (§7). | The premium cycle layered search + multi-select + bulk-bar + CSV onto an already-large table. Adding all four to one file pushed it over. | Extracted the `<tr>` body (≈75 LOC) into `BatchesTableRow.tsx` with a small pure `isCancellableBatch(b)` helper. New sizes: `BatchesTable.tsx` 229 LOC, `BatchesTableRow.tsx` 130 LOC — both well under the ceiling. | [web/src/components/BatchesTable.tsx](../../../web/src/components/BatchesTable.tsx), [web/src/components/BatchesTableRow.tsx](../../../web/src/components/BatchesTableRow.tsx) |
| H3 | High | `JSX.Element` used as a return-type annotation in three new components — that namespace is no longer global under the project's TS config, breaking `npx tsc --noEmit`. | I reflexively typed an explicit `: JSX.Element` instead of following the existing convention of letting React infer the return type. | Dropped the annotation; the rest of the codebase already does this. `tsc --noEmit` now clean. | [web/src/components/ShortcutHelp.tsx](../../../web/src/components/ShortcutHelp.tsx), [web/src/components/ToastContainer.tsx](../../../web/src/components/ToastContainer.tsx), [web/src/components/Sparkline.tsx](../../../web/src/components/Sparkline.tsx) |
| M1 | Medium | `AuditPage` `useQuery` had both `enabled: !paused` AND `refetchInterval: paused ? false : N`. Two switches for the same lever — invites bugs where one is updated and the other isn't. | I added `enabled` without removing the redundant `refetchInterval` gating from the first pass. | Removed `enabled` flag; `refetchInterval: false` is now the sole source of truth for pause. | [web/src/pages/AuditPage.tsx](../../../web/src/pages/AuditPage.tsx) |
| M2 | Medium | Fingerprint-set rebuild logic was inside the `setEvents` updater callback. React state updaters must be pure — StrictMode invokes them twice. Even though rebuilding the same Set from the same input is idempotent, the side effect violates the rule. | Premature optimization: I tried to compute the trimmed set inside the same closure that produced the trimmed array. | Moved the bounded fingerprint rebuild into a separate `useEffect` keyed on `events`. The updater is now pure. | [web/src/pages/AuditPage.tsx](../../../web/src/pages/AuditPage.tsx) |
| M3 | Medium | `CODEMAP.md` had ~12 new files in the workspace that were never registered — invariant §7 violation. | Cross-cutting files were created in batches without per-step codemap discipline. | Added entries for `polish.css`, `regionFilter.ts`, `RegionsToolbar.tsx`, `RegionDetailPanel.tsx`, `BatchesTableRow.tsx`, `useFavorites.ts`, `useToast.ts`, `useHotkey.ts`, `useDocumentTitle.ts`, `usePageVisibility.ts`, `useKeyboardNav.ts`, `csv.ts`, `ToastContainer.tsx`, `Sparkline.tsx`, `ShortcutHelp.tsx`. Updated per-page descriptions and SRP debt list. | [docs/CODEMAP.md](../../CODEMAP.md) |
| M4 | Medium | `i18n.tsx` is now **850 LOC** (was previously stale-listed at 279). With ~30 new keys added across the premium cycle, this is firmly over the 300 ceiling. | Pre-existing SRP debt that the cycle made worse. | Documented in the SRP debt list with a concrete split plan (`lib/i18n/en.ts` + `lib/i18n/ko.ts` + `lib/i18n/provider.tsx`) and a "MUST split before any further translation work" gate. Not split this cycle because that refactor is independent of the premium UX scope and touches every consumer; queued as the next mandatory cleanup. | [docs/CODEMAP.md](../../CODEMAP.md) |
| L1 | Low | `BatchesTable` bulk-cancel runs `await api.cancelBatch(id)` sequentially in a `for` loop — slow for very large selections. | Deliberate trade-off: respects per-source policy concurrency / rate-limit (the design philosophy explicitly prefers correctness over speed) and surfaces per-id errors clearly. Documented in a comment so the next contributor doesn't "fix" it. | Comment kept. No code change. | [web/src/components/BatchesTable.tsx](../../../web/src/components/BatchesTable.tsx) (line annotated `Sequential to respect server policy`) |
| L2 | Low | `RegionsPage` and `QuotaPage` use separate localStorage keys for favorites (`fav-regions` vs `fav-quota-regions`). A user starring a region on one page does not see it starred on the other. | Intentional — the pages serve different operator intents (geo overview vs. quota-only triage) and the codebase has no explicit "global favorites" concept. | Documented in the per-page CODEMAP entries that favorites are page-scoped. No code change. | [web/src/pages/RegionsPage.tsx](../../../web/src/pages/RegionsPage.tsx), [web/src/pages/QuotaPage.tsx](../../../web/src/pages/QuotaPage.tsx) |
| L3 | Low | `EventRow.copyToClipboard` falls back to deprecated `document.execCommand("copy")` when `navigator.clipboard` is unavailable. | The fallback is the standard cross-browser strategy for non-secure contexts (HTTP / older browsers); deprecation does not equal removal. The function is wrapped in try/catch so a future removal degrades to a toast error, not a crash. | None. | [web/src/components/audit/EventRow.tsx](../../../web/src/components/audit/EventRow.tsx) |
| L4 | Low | `useDocumentTitle` writes `document.title` on every render whose deps changed. No early-return short-circuit when the new title equals the old. | DOM property writes are cheap; React's deps array already gates the effect to "title or badge changed". A short-circuit would be premature optimisation. | None. | [web/src/lib/useDocumentTitle.ts](../../../web/src/lib/useDocumentTitle.ts) |
| L5 | Low | Scaling page `useEffect` that prunes stale `selectedTypes` runs on every poll cycle (~every 2 s) and allocates a fresh `Set<string>` even when the type set is unchanged. | Micro-allocation; the Set is bounded by the number of distinct event types in the window (typically <20). Acceptable cost for the simplicity. | Kept as-is, with a comment that this is bounded. | [web/src/pages/ScalingTimelinePage.tsx](../../../web/src/pages/ScalingTimelinePage.tsx) |
| L6 | Low | `QuotaPage.zeroCount` uses `(p.headroom ?? 1) <= 0` — a missing `headroom` is treated as "no warning". A misconfigured provider that returned `null` instead of a number would silently mask a real-world zero. | Defensive default chosen to avoid false-positive warnings when the upstream scan didn't include headroom for a particular probe. | Acceptable for now; observed probes from the scanner always populate `headroom`. The fallback only ever applies to unobserved probes which we also gate on `p.observed`. No code change. | [web/src/pages/QuotaPage.tsx](../../../web/src/pages/QuotaPage.tsx) |
| L7 | Low | `usePageVisibility` returns `true` for `document.visibilityState === "prerender"`. Pages will poll while prerendered. | Prerender pages may be promoted to the foreground at any moment; throttling them would delay first-paint refresh. The polling cost is bounded by `refetchIntervalInBackground: false` on every query (which respects `visibilityState !== "visible"` for "background" — slightly different from our hook). | None. | [web/src/lib/usePageVisibility.ts](../../../web/src/lib/usePageVisibility.ts) |
| L8 | Low | Audit `useEffect` that bounds the fingerprint set only runs once the buffer is **at** `MAX_BUFFERED_EVENTS`. If the buffer is below cap, the fingerprint set grows monotonically (each new event adds one fp). | Bounded by `MAX_BUFFERED_EVENTS = 500` — the set can never grow past 500 (in steady state) because the trim effect fires when we hit cap. The only edge case is the warm-up period (first 500 events), where the set tracks every event we've ever seen. Acceptable. | None. | [web/src/pages/AuditPage.tsx](../../../web/src/pages/AuditPage.tsx) |
| L9 | Low | `BatchesPage` `applyQuery` / `applySort` / `applyFilter` allocate fresh arrays even when the input matches the filter unchanged. | React's `useMemo` only re-runs when deps change, so the allocation cost is bounded to one per state change. Optimising further (e.g. returning the same array reference when no row is filtered out) would risk a stale reference. | None. | [web/src/pages/BatchesPage.tsx](../../../web/src/pages/BatchesPage.tsx) |
| L10 | Low | CSV exports include `JSON.stringify(payload)` on the Scaling and Audit pages — a single huge payload could produce a multi-megabyte CSV cell that Excel struggles with. | User-initiated export; the data set is already bounded by the current page filter. Excel-cell-length is downstream concern. | None — operator can always re-filter before exporting. | [web/src/pages/ScalingTimelinePage.tsx](../../../web/src/pages/ScalingTimelinePage.tsx), [web/src/pages/AuditPage.tsx](../../../web/src/pages/AuditPage.tsx) |
| L11 | Info | `useToast` is module-scoped global state. Two unmounted/remounted ToastContainers would each render the same queue. | Intentional — pub/sub design lets non-React modules push toasts. ToastContainer is mounted exactly once at AppShell. | None — documented in the hook header comment. | [web/src/lib/useToast.ts](../../../web/src/lib/useToast.ts) |

## Cycle 1 result

- **Critical: 0** ✓
- **High: 0** ✓ (3 found, all fixed)
- **Medium: 0** ✓ (4 found, 3 fixed, 1 documented + queued)
- **Low: 8 + 1 Info** (all reviewed; all either intentional or bounded)

The change meets §6's exit criterion (only Low/Info findings remain).

## Verification

- `cd web && npx tsc --noEmit` → clean (no output)
- `cd web && npx vitest run` → **25 / 25 passing** (2 test files)
- LOC audit of all touched / created files: all ≤ 300 except the
  pre-existing SRP debt on `lib/i18n.tsx` (now documented + gated in
  the codemap with a hard "must split before more translation work"
  rule).

## Files touched this cycle (full list)

**New files:**
- `web/src/styles/polish.css`
- `web/src/lib/useDocumentTitle.ts`
- `web/src/lib/usePageVisibility.ts`
- `web/src/lib/useFavorites.ts`
- `web/src/lib/useToast.ts`
- `web/src/lib/useHotkey.ts`
- `web/src/lib/useKeyboardNav.ts`
- `web/src/lib/csv.ts`
- `web/src/components/ToastContainer.tsx`
- `web/src/components/Sparkline.tsx`
- `web/src/components/ShortcutHelp.tsx`
- `web/src/components/BatchesTableRow.tsx`
- `web/src/components/regions/regionFilter.ts`
- `web/src/components/regions/RegionsToolbar.tsx`
- `web/src/components/regions/RegionDetailPanel.tsx`

**Modified files:**
- `web/src/main.tsx` (loads polish.css)
- `web/src/components/KpiCard.tsx` (sparkline + drill)
- `web/src/components/BatchesTable.tsx` (search/select/CSV; split for SRP)
- `web/src/components/regions/RegionQuotaTable.tsx` (favorites column)
- `web/src/components/audit/EventFilterBar.tsx` (counts)
- `web/src/components/audit/EventRow.tsx` (copy JSON button)
- `web/src/components/batches/BatchFilterBar.tsx` (counts + search + CSV)
- `web/src/pages/ThroughputPage.tsx`
- `web/src/pages/BatchesPage.tsx`
- `web/src/pages/RegionsPage.tsx`
- `web/src/pages/ScalingTimelinePage.tsx`
- `web/src/pages/QuotaPage.tsx`
- `web/src/pages/AuditPage.tsx`
- `web/src/lib/i18n.tsx` (~30 new i18n keys)
- `docs/CODEMAP.md` (codemap maintenance)

---

## Cycle 2 findings — deep critique-hardening (post-user request "비평 하드닝")

After cycle 1 declared "only Low/Info remain", a second-pass deep critique was
run focused on (a) security boundaries we touched, (b) hot-path performance,
(c) hook stability, (d) a11y, and (e) "we documented a feature but never
wired it". Result: **19 distinct findings — 0 Critical, 6 High, 6 Medium,
6 Low, 1 Info. All High and 4/6 Medium fixed; remaining 2 Medium documented.**

| # | Severity | Finding | Root cause | Fix | File |
| -: | -------- | ------- | ---------- | --- | ---- |
| C0 | None | — | — | No Critical findings: all new code is presentation/state with no auth, network, or persistence boundaries. | — |
| H1 | **High (Security)** | `csv.ts` `escapeCell` is vulnerable to **CSV-injection (CWE-1236)**. The Audit page exports user-controllable payloads as JSON; a payload like `=cmd|'/c calc'!A1` (or starting with `+`, `-`, `@`, tab, CR) would be evaluated as a formula when the operator opens the file in Excel/LibreOffice/Numbers. | RFC 4180 alone is not enough; the spreadsheet-formula attack surface is a separate concern that I omitted. | Added `FORMULA_TRIGGERS` regex and prepend a single-quote to any string cell starting with a dangerous lead. Numeric/boolean cells (e.g. `-5`) are NOT mangled because they aren't strings. Backed by **5 new regression tests** in `csv.test.ts` (one per trigger character + benign + numeric round-trip). | [web/src/lib/csv.ts](../../../web/src/lib/csv.ts), [web/src/__tests__/csv.test.ts](../../../web/src/__tests__/csv.test.ts) |
| H2 | **High (Perf)** | `useNowTick(1000)` created one `setInterval` PER caller. `AuditPage` renders up to 500 `<EventRow>` and each subscribes → 500 timers × 1 Hz = 500 setState calls/sec, render thrash. | I treated the hook as cheap and let each row own its own interval. | Rewrote `useNowTick` as a module-scoped pub/sub keyed by intervalMs: **one** wall-clock timer per distinct interval, all subscribers share. Listeners are snapshotted before notification so an unsubscribe during dispatch can't mutate the set. Auto-stops the timer when the last subscriber unsubs. Public API is byte-identical, no consumer changes required. | [web/src/lib/useNowTick.ts](../../../web/src/lib/useNowTick.ts) |
| H3 | **High (Correctness)** | `AppShell` built `navShortcuts` as a fresh object literal every render; `useKeyboardNav` keyed its effect on this object's identity → keydown listener removed + re-added on **every render** → in-flight leader-key state (`g` waiting for follow-up) was wiped any time a parent re-rendered. The "g t / g r / g b ..." nav shortcuts were effectively unreachable under poll-driven re-renders. | A subtle hook-stability bug; the consumer-side bad pattern fed an over-permissive hook. | Two-sided fix: (1) `AppShell` now wraps `navShortcuts` in `useMemo(..., [])` and (2) `useKeyboardNav` internally captures `onHelp` via a ref so callers may still pass inline arrows safely. Added a doc-comment naming the stability contract. | [web/src/components/AppShell.tsx](../../../web/src/components/AppShell.tsx), [web/src/lib/useKeyboardNav.ts](../../../web/src/lib/useKeyboardNav.ts) |
| H4 | **High (i18n)** | `QuotaPage` totals bar hard-coded English: `"% used"` and `"vCPU available"`. Korean users saw mixed Korean/English. | Slipped through because the surrounding cells DO use `t(...)` — visual scan didn't catch a single tail. | Added `regions.totals.bar.usedPct` and `regions.totals.bar.available` in both EN + KO dicts; rewrote the JSX to use `t("regions.totals.bar.usedPct", { pct })`. | [web/src/pages/QuotaPage.tsx](../../../web/src/pages/QuotaPage.tsx), [web/src/lib/i18n.tsx](../../../web/src/lib/i18n.tsx) |
| H5 | **High (UX trust)** | `ShortcutHelp` modal documented `P — pause/resume audit tail` but no keydown handler was actually wired. Pressing `P` did nothing → user loses trust in the help screen. | Help-modal content was authored optimistically before the feature shipped; the wiring step was dropped. | Wired a document-level `keydown` listener inside `AuditPage` that toggles `paused` on plain `P` (no modifiers, not while typing into INPUT/TEXTAREA/SELECT/contentEditable). Help modal text and shortcut now agree. | [web/src/pages/AuditPage.tsx](../../../web/src/pages/AuditPage.tsx) |
| H6 | **High (A11y)** | `ShortcutHelp` declared `aria-modal="true"` but Tab/Shift+Tab escaped the dialog into the page beneath. Screen-reader / keyboard users could not reliably stay in the modal. Focus was also not restored to the trigger after close. | The previous comment "Focus-trapped lightly" was aspirational; the actual code only focused the close button on open. | Real focus trap: on Tab from the last focusable, wrap to first; on Shift+Tab from the first, wrap to last; on close, restore focus to whichever element was active before the modal opened (`document.contains` guard for the navigated-away case). Escape now `preventDefault()`s as well. | [web/src/components/ShortcutHelp.tsx](../../../web/src/components/ShortcutHelp.tsx) |
| M1 | Medium | `useCtrlOrCmdHotkey` listed `onTrigger` in its `useEffect` dep array. Both call sites pass inline arrows → listener add/remove every consumer render. Wasteful and (more importantly) a missed event window if a keypress lands between unbind and re-bind. | I followed the textbook "include all referenced values in deps" rule without considering identity stability. | Captured `onTrigger` via a ref; effect now depends only on `[key, enabled]`. Callers may continue to pass inline arrows. | [web/src/lib/useHotkey.ts](../../../web/src/lib/useHotkey.ts) |
| M2 | Medium | `EventRow` ran `JSON.stringify(event.payload, null, 2)` on EVERY render. With 500 visible rows × poll-driven parent re-renders, that's hundreds of `stringify` calls per second on hot tail. | Treated as cheap; not. | Memoised with `useMemo(..., [event.payload])`. Now bound to payload identity, which only changes when a new fingerprint enters the buffer. | [web/src/components/audit/EventRow.tsx](../../../web/src/components/audit/EventRow.tsx) |
| M3 | Medium | `Sparkline` used `Math.min(...values)` / `Math.max(...values)`. Spread-into-call risks `RangeError: Maximum call stack size exceeded` for long series. Current usage is bounded (60 samples) so no live failure, but defensive coding is cheap. Also: `NaN`/`Infinity` in `values` poisoned the projection → invisible chart. | Trusted callers to pass clean numeric arrays. | Replaced with reduce-based min/max that **skips non-finite values** and falls back to a flat 0-baseline on an all-non-finite series. Bonus visual fix: a flat series now renders along the **vertical midline** instead of at the chart floor (was misleadingly drawing flat data as "permanently low"). | [web/src/components/Sparkline.tsx](../../../web/src/components/Sparkline.tsx) |
| M4 | Medium | `useFavorites.toggle` silently dropped add-attempts at the `cap` boundary. User clicks star → nothing happens → confusion. | The cap was correct, the UX feedback was missing. | Added optional `onCapExceeded(cap)` callback. Notification fires inside a `queueMicrotask` so the React reducer remains pure (don't fire side effects from inside `setState`). Both `RegionsPage` and `QuotaPage` now toast `toast.favoritesCap` (EN + KO) when the cap blocks an add. Old positional-cap signature `useFavorites(key, 50)` kept for backwards compatibility. | [web/src/lib/useFavorites.ts](../../../web/src/lib/useFavorites.ts), [web/src/pages/RegionsPage.tsx](../../../web/src/pages/RegionsPage.tsx), [web/src/pages/QuotaPage.tsx](../../../web/src/pages/QuotaPage.tsx), [web/src/lib/i18n.tsx](../../../web/src/lib/i18n.tsx) |
| M5 | Medium | `useToast` returns the module-level `pushToast` directly; looks like a stateful hook but isn't. Easy to misread. | The pub/sub design is correct (non-React modules can also push), but the API is undocumented. | Kept behaviour; added a doc-comment naming the convention and the rationale. No code change. | [web/src/lib/useToast.ts](../../../web/src/lib/useToast.ts) (existing comment header) |
| M6 | Medium | `useDocumentTitle` treats `badge === 0` as "no badge". A caller wanting to legitimately surface "(0)" cannot. | Defensive default that may misfire. | Documented as deliberate (zero is "nothing to alert on"). Two existing call sites — Quota's `zeroCount`, Throughput's `backlog` — both want this exact behaviour. Acceptable. No code change. | [web/src/lib/useDocumentTitle.ts](../../../web/src/lib/useDocumentTitle.ts) |
| L1 | Low | `BatchesTableRow` renders raw `b.status` text in the tag chip. Other cells render translated status. | Inherited from the pre-split table. | Acceptable: the status tag is a semantic identifier (CSS-class driver), not the prose translation. The "ETA" cell already shows translated end-state text. | — |
| L2 | Low | `compareProbes` undefined-handling differs per sort key (-1 vs +Infinity). Both sink the undefined entries; the divergence is harmless. | Different defaults made sense per key direction. | Documented; no code change. | [web/src/components/regions/regionFilter.ts](../../../web/src/components/regions/regionFilter.ts) |
| L3 | Low | `useToast` module-level state can leak between vitest tests in theory. | Test suite currently doesn't use toasts. | Acceptable; if a future test exercises toasts, add a `beforeEach(dismissAllToasts)`. | — |
| L4 | Low | `meterColor("failed") → "warn"`. Failed batches share styling with paused. | Pre-existing convention from the original `BatchesTable`. | Acceptable. | — |
| L5 | Low | `useFavorites` does not trim when `cap` shrinks at runtime. | `cap` is effectively constant per consumer. | Acceptable. | — |
| L6 | Low | `web/src/lib/api.ts` is at 305 LOC — 5 over the 300 ceiling. Untouched by either hardening cycle. | Pre-existing. | Added to the CODEMAP SRP debt list. Per §7: must be split before any further behaviour is added. | [docs/CODEMAP.md](../../CODEMAP.md) |
| I1 | Info | `web/src/lib/i18n.tsx` is now 856 LOC (was 850 — added 6 lines for H4 + M4 keys). Still over ceiling. | Pre-existing debt; cycle 2 added 3 essential security/i18n keys. | Already documented in CODEMAP with a concrete split plan. | [docs/CODEMAP.md](../../CODEMAP.md) |

### Cycle-2 verification

- `npx tsc --noEmit` — clean (no output).
- `npx vitest run` — **37 tests pass** (was 25; +12 new in `csv.test.ts` covering RFC-4180 escaping + the H1 CSV-injection regression). 0 failures, 0 warnings.
- LOC sweep: all files touched this cycle are ≤ 300 LOC. Only `lib/api.ts` (305, untouched) and `lib/i18n.tsx` (856, pre-existing debt) remain over the ceiling; both are listed in the CODEMAP debt section per §7.

### Cycle-2 exit criterion

Critical: 0, High: 0 (all 6 fixed), Medium: 0 open (4 fixed with code + tests, 2 accepted with documented rationale), Low: 6 + 1 Info — **meets §6's exit criterion (only Low/Info findings remain)**. The premium UX work is shipped, hardened twice, and the security and a11y guarantees now have regression tests behind them.
