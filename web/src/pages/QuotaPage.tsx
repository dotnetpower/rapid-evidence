import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type DashboardSummary } from "../lib/api";
import { useI18n } from "../lib/i18n";
import { QuotaMeter } from "../components/quota/QuotaMeter";
import { JobsPanel } from "../components/jobs/JobsPanel";
import { RegionQuotaTable } from "../components/regions/RegionQuotaTable";
import { extractProbeBundle } from "../components/regions/probeBundle";
import { formatNumber, timeAgo } from "../lib/format";
import "../styles/quota-regions.css";

export function QuotaPage() {
  const { t } = useI18n();
  const qc = useQueryClient();
  const [selected, setSelected] = useState<string | null>(null);

  const quota = useQuery({
    queryKey: ["quota-status"],
    queryFn: () => api.quotaStatus(),
    refetchInterval: 30000,
    staleTime: 15000,
  });
  const summary = useQuery({
    queryKey: ["dashboard-summary"],
    queryFn: () => api.dashboardSummary(),
    refetchInterval: 5000,
  });
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
              ? t("regions.totals.lastScan", { ago: timeAgo(bundle.lastScanAt) })
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
        <div className="panel">
          <div className="panel-head">
            <span className="title">
              {provider ? `provider: ${provider}` : t("quota.page.title")}
            </span>
            <span className="meta">
              {t("quota.checked")}:{" "}
              {status.checked_at ? timeAgo(status.checked_at) : t("quota.never")}
            </span>
          </div>
          <div style={{ padding: 14 }}>
            <QuotaMeter status={status} />
            {status.error ? (
              <div className="error-banner" style={{ marginTop: 12 }}>
                {t("quota.error")}: {status.error}
              </div>
            ) : null}
          </div>
        </div>
      )}

      {/* Per-region quota detail — the same table the Regions page uses,
          shown here so operators see headroom right where they triggered
          the scan. */}
      <section className="panel" style={{ marginTop: 12 }}>
        <div className="panel-head">
          <span className="title">{t("regions.quotaTable.title")}</span>
          <span className="meta">{bundle.totalCount}</span>
        </div>
        <RegionQuotaTable
          probes={bundle.probes}
          selected={selected}
          onSelect={setSelected}
        />
      </section>

      <JobsPanel />
    </>
  );
}
