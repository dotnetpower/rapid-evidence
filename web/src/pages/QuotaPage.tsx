import { useMemo, useState } from "react";
import { useQuery, useQueryClient, type UseQueryResult } from "@tanstack/react-query";
import { useOutletContext } from "react-router-dom";
import { api, type DashboardSummary } from "../lib/api";
import { useI18n } from "../lib/i18n";
import { useDocumentTitle } from "../lib/useDocumentTitle";
import { useFavorites } from "../lib/useFavorites";
import { useToast } from "../lib/useToast";
import { downloadCsv, csvDateStamp } from "../lib/csv";
import { QuotaMeter } from "../components/quota/QuotaMeter";
import { JobsPanel } from "../components/jobs/JobsPanel";
import { RegionQuotaTable } from "../components/regions/RegionQuotaTable";
import { RegionsToolbar } from "../components/regions/RegionsToolbar";
import {
  filterProbes,
  sortProbes,
  type RegionSortKey,
} from "../components/regions/regionFilter";
import { extractProbeBundle } from "../components/regions/probeBundle";
import { formatNumber, timeAgo } from "../lib/format";
import { useNowTick } from "../lib/useNowTick";
import "../styles/quota-regions.css";

export function QuotaPage() {
  const { t } = useI18n();
  const qc = useQueryClient();
  const toast = useToast();
  const [selected, setSelected] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<RegionSortKey>("headroom-asc");
  const favorites = useFavorites("rapid-evidence:fav-quota-regions", {
    onCapExceeded: (cap) => toast(t("toast.favoritesCap", { cap }), "info"),
  });
  const now = useNowTick(1000);

  const quota = useQuery({
    queryKey: ["quota-status"],
    queryFn: () => api.quotaStatus(),
    refetchInterval: 30000,
    staleTime: 15000,
  });
  // Reuse the shell-level dashboard-summary query (same cache key) instead
  // of declaring a parallel observer. The previous local useQuery kept a
  // constant 5s `refetchInterval` even with the tab hidden, so the shell's
  // `tabVisible` guard couldn't silence it \u2014 wasting up to 12
  // requests/min on a background tab.
  const summary = useOutletContext<UseQueryResult<DashboardSummary>>();
  const jobs = useQuery({
    queryKey: ["jobs", "quota-page"],
    queryFn: () => api.jobsList(100),
    refetchInterval: 5000,
    staleTime: 3000,
  });

  const provider = (summary.data as DashboardSummary | undefined)?.pool?.provider;
  const status = quota.data;
  const bundle = useMemo(
    () => extractProbeBundle(jobs.data?.jobs ?? []),
    [jobs.data],
  );
  const hasScan = bundle.totalCount > 0;

  const filteredProbes = useMemo(
    () => filterProbes(bundle.probes, query),
    [bundle.probes, query],
  );
  const sortedProbes = useMemo(
    () => sortProbes(filteredProbes, sort, favorites.set),
    [filteredProbes, sort, favorites.set],
  );

  // Tab title surfaces the count of probed regions with zero headroom.
  const zeroCount = useMemo(
    () => bundle.probes.filter((p) => p.observed && (p.headroom ?? 1) <= 0).length,
    [bundle.probes],
  );
  useDocumentTitle(t("quota.page.title"), zeroCount > 0 ? zeroCount : null);

  function exportCsv() {
    if (sortedProbes.length === 0) {
      toast(t("toast.csvEmpty"), "info");
      return;
    }
    const headers = ["region", "used", "limit", "headroom", "observed", "favorite", "error"];
    const data = sortedProbes.map((p) => [
      p.region,
      p.used ?? "",
      p.limit ?? "",
      p.headroom ?? "",
      p.observed ? "yes" : "no",
      favorites.has(p.region) ? "yes" : "no",
      p.error ?? "",
    ]);
    downloadCsv(`quota-${csvDateStamp()}.csv`, headers, data);
    toast(t("toast.csvExported", { n: data.length }), "success");
  }

  return (
    <>
      <div className="page-head">
        <div>
          <h1>{t("quota.page.title")}</h1>
          <div className="sub">{t("quota.page.sub")}</div>
        </div>
        <div className="actions">
          <button
            className="btn"
            onClick={() => {
              quota.refetch();
              qc.invalidateQueries({ queryKey: ["dashboard-summary"] });
              qc.invalidateQueries({ queryKey: ["jobs"] });
            }}
            disabled={quota.isFetching}
          >
            ⟳ {t("quota.refresh")}
          </button>
        </div>
      </div>

      {/* Subscription-level totals from the most recent multi-region scan. */}
      <section className="panel quota-totals" style={{ marginBottom: 12 }}>
        <div className="panel-head">
          <span className="title">{t("regions.totals.title")}</span>
          <span className="meta">
            {hasScan
              ? t("regions.totals.lastScan", { ago: timeAgo(bundle.lastScanAt, now) })
              : t("regions.totals.noScan")}
            {bundle.spotQuotaName ? ` · ${bundle.spotQuotaName}` : ""}
          </span>
        </div>
        <div className="quota-totals__grid">
          <div className="quota-totals__cell">
            <div className="lbl">{t("regions.totals.limit")}</div>
            <div className="val">{formatNumber(bundle.totalLimit)}</div>
          </div>
          <div className="quota-totals__cell">
            <div className="lbl">{t("regions.totals.used")}</div>
            <div className="val">{formatNumber(bundle.totalUsed)}</div>
          </div>
          <div className="quota-totals__cell ok">
            <div className="lbl">{t("regions.totals.headroom")}</div>
            <div className="val">{formatNumber(bundle.totalHeadroom)}</div>
          </div>
          <div className="quota-totals__cell">
            <div className="lbl">{t("regions.totals.observed")}</div>
            <div className="val">
              {bundle.observedCount} / {bundle.totalCount}
            </div>
          </div>
        </div>
        {bundle.totalLimit > 0 && (
          <div style={{ padding: "4px 16px 14px" }}>
            <div
              className="quota-bar"
              style={{ height: 14 }}
              title={`${bundle.totalUsed} / ${bundle.totalLimit}`}
            >
              <div
                className="quota-bar__fill"
                style={{
                  width: `${Math.max(0.5, Math.min(100, (bundle.totalUsed / bundle.totalLimit) * 100))}%`,
                  background:
                    bundle.totalHeadroom === 0
                      ? "var(--warn, #e6c47a)"
                      : "var(--ok, #5db075)",
                }}
              />
            </div>
            <div
              style={{
                fontSize: 11,
                marginTop: 6,
                color: "var(--text-muted)",
                display: "flex",
                justifyContent: "space-between",
              }}
            >
              <span>
                {t("regions.totals.bar.usedPct", {
                  pct: ((bundle.totalUsed / bundle.totalLimit) * 100).toFixed(1),
                })}
              </span>
              <span>
                {t("regions.totals.bar.available", {
                  n: formatNumber(bundle.totalHeadroom),
                })}
              </span>
            </div>
          </div>
        )}
      </section>

      {/* Local single-region quota that the active pool provider exposes.
          Useful for the in-memory demo or when the active region differs
          from the scanned subscription-wide set. */}
      {!status || !status.observed ? (
        <div className="panel">
          <div className="empty">
            {t("quota.notObserved")}
            {provider ? <div style={{ opacity: 0.6, marginTop: 6 }}>provider: {provider}</div> : null}
          </div>
        </div>
      ) : (
        <details className="panel quota-secondary" open style={{ marginTop: 8 }}>
          <summary className="panel-head" style={{ cursor: "pointer" }}>
            <span className="title">
              {provider ? `${t("quota.localProvider")}: ${provider}` : t("quota.page.title")}
            </span>
            <span className="meta">
              {t("quota.checked")}:{" "}
              {status.checked_at ? timeAgo(status.checked_at, now) : t("quota.never")}
            </span>
          </summary>
          <div style={{ padding: 14 }}>
            <QuotaMeter status={status} />
            {status.error ? (
              <div className="error-banner" style={{ marginTop: 12 }}>
                {t("quota.error")}: {status.error}
              </div>
            ) : null}
          </div>
        </details>
      )}

      {/* Per-region quota detail — the same table the Regions page uses,
          shown here so operators see headroom right where they triggered
          the scan. */}
      <section className="panel" style={{ marginTop: 12 }}>
        <div className="panel-head">
          <span className="title">{t("regions.quotaTable.title")}</span>
          <span className="meta">{bundle.totalCount}</span>
        </div>
        <RegionsToolbar
          query={query}
          onQuery={setQuery}
          sort={sort}
          onSort={setSort}
          onExport={exportCsv}
          exportDisabled={sortedProbes.length === 0}
          matchCount={filteredProbes.length}
          totalCount={bundle.probes.length}
        />
        <RegionQuotaTable
          probes={sortedProbes}
          selected={selected}
          onSelect={setSelected}
          lastScanAt={bundle.lastScanAt}
          nowMs={now}
          favorites={favorites.set}
          onToggleFavorite={favorites.toggle}
        />
      </section>

      <JobsPanel />
    </>
  );
}
