# Web — EN/KO Language Toggle (i18n)

**Date:** 2026-05-28
**Status:** implemented

## Summary

The dashboard shipped with Korean-only labels which was a usability
blocker for English-speaking operators. This change introduces a
minimal in-house i18n layer (no `react-i18next` dependency) and a
two-button language toggle (`EN` / `한`) in the titlebar.

## Implementation

- New `web/src/lib/i18n.tsx`:
  - `Lang = "en" | "ko"`, English and Korean dictionaries (~80
    keys each, covering every visible string in the app).
  - `I18nProvider` — React context provider; persists the selection
    in `localStorage["rapid-evidence:lang"]` and falls back to
    `navigator.language` (`ko*` → Korean, else English).
  - `useI18n()` hook → `{ lang, setLang, toggle, t }`.
  - `t(key, vars?)` does `{var}` interpolation and falls back to the
    English dictionary then the raw key when a translation is missing,
    so adding new strings cannot crash the UI.
- `web/src/main.tsx` wraps the app in `<I18nProvider>` above
  `<QueryClientProvider>` so the toggle is available everywhere.
- All components now go through `t(key)`:
  - `components/AppShell.tsx` — titlebar (toggle, status pill,
    crumbs), sidebar nav, statusbar segments.
  - `pages/ThroughputPage.tsx` — page title, refresh/new-batch
    buttons, error banners, KPI labels/details.
  - `components/PoolPanel.tsx` — pool panel title, row labels,
    Spot Nodes table headers, Recent Evictions list label.
  - `components/BatchesTable.tsx` — queue title, column headers,
    status labels, eviction/node-count tooltips.
  - `components/NewBatchDialog.tsx` — dialog title/labels/buttons.
  - `components/ThroughputChart.tsx` — chart title and legend.
- `web/src/styles/app.css` — `.lang-btn.on` pill style for the
  active language button.

## UX behaviour

- Two-button group, current language shown with `aria-pressed=true`
  and an accent fill.
- Switching is instant (React re-render via context value change);
  no page reload.
- Choice persists across refresh and across the day.
- First visit picks Korean only when `navigator.language` starts with
  `ko`; default for everyone else is English.

## Verification

- `npm test -- --run` → 4 vitest pass.
- `npm run build` → tsc + vite build clean (~+12 KB gzip for the
  dictionary).
- Browser walkthrough on `http://localhost:5175`:
  - EN toggle shows "Throughput / Backlog · pool scaling · …" / "New
    batch" / "Pool scaling progress" / "Batch queue · N" etc.
  - KO toggle shows "처리량 / 백로그 · 풀 확장 속도 · …" / "새 배치"
    / "풀 확장 진행" / "배치 큐 · N개" etc.
  - Reload after switching → previously chosen language restored from
    `localStorage`.

## Affected files

- `web/src/lib/i18n.tsx` (new)
- `web/src/main.tsx`
- `web/src/components/AppShell.tsx`
- `web/src/pages/ThroughputPage.tsx`
- `web/src/components/PoolPanel.tsx`
- `web/src/components/BatchesTable.tsx`
- `web/src/components/NewBatchDialog.tsx`
- `web/src/components/ThroughputChart.tsx`
- `web/src/styles/app.css`
