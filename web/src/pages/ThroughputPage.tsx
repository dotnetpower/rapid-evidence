import { useState } from "react";
import { useOutletContext } from "react-router-dom";
import type { UseQueryResult } from "@tanstack/react-query";
import { KpiCard } from "../components/KpiCard";
import { ThroughputChart } from "../components/ThroughputChart";
import { PoolPanel } from "../components/PoolPanel";
import { BatchesTable } from "../components/BatchesTable";
import { NewBatchDialog } from "../components/NewBatchDialog";
import type { DashboardSummary } from "../lib/api";
import { formatDuration, formatNumber, formatRate } from "../lib/format";
import { useI18n } from "../lib/i18n";

export function ThroughputPage() {
  const summary = useOutletContext<UseQueryResult<DashboardSummary>>();
  const [dialogOpen, setDialogOpen] = useState(false);
  const { t } = useI18n();

  const data = summary.data;
  const counters = data?.pool?.counters ?? {};
  const config = data?.pool?.config;

  const activeVms =
    Number(counters.ready ?? 0) +
    Number(counters.busy ?? 0) +
    Number(counters.provisioning ?? 0) +
    Number(counters.draining ?? 0) +
    Number(counters.terminating ?? 0);
  const target = data?.scale_target?.target_nodes ?? config?.max_nodes ?? 0;
  const maxNodes = config?.max_nodes ?? 0;

  return (
    <>
      <div className="page-head">
        <div>
          <h1>{t("page.throughput.title")}</h1>
          <div className="sub">{t("page.throughput.sub")}</div>
        </div>
        <div className="actions">
          <button
            className="btn"
            onClick={() => summary.refetch()}
            disabled={summary.isFetching}
          >
            ⟳ {t("page.refresh")}
          </button>
          <button className="btn primary" onClick={() => setDialogOpen(true)}>
            ＋ {t("page.newBatch")}
          </button>
        </div>
      </div>

      {summary.isError && summary.dataUpdatedAt > 0 && (
        <div className="error-banner" style={{ marginBottom: 16 }}>
          {t("page.err.apiDown")}
        </div>
      )}
      {summary.isError && summary.dataUpdatedAt === 0 && (
        <div
          className="error-banner"
          style={{ marginBottom: 16, background: "#3a2f1a", borderColor: "#7a5d20", color: "#e6c47a" }}
        >
          {t("page.err.apiBoot")}
        </div>
      )}

      <div className="kpis">
        <KpiCard
          label={t("kpi.backlog.label")}
          value={formatNumber(data?.backlog ?? 0)}
          unit={t("kpi.backlog.unit")}
          detail={data ? t("kpi.backlog.activeBatches", { n: data.active_batches }) : "—"}
        />
        <KpiCard
          label={t("kpi.tp.label")}
          value={data ? data.throughput_per_second.toFixed(data.throughput_per_second >= 10 ? 0 : 1) : "—"}
          unit={t("kpi.tp.unit")}
          detail={
            data?.latest_sample
              ? t("kpi.tp.activeSamples", { n: data.latest_sample.active_batches })
              : "—"
          }
        />
        <KpiCard
          label={t("kpi.drain.label")}
          value={formatDuration(data?.drain_eta_seconds ?? null)}
          detail={
            data?.drain_eta_seconds == null && (data?.backlog ?? 0) > 0
              ? t("kpi.drain.starved")
              : data?.drain_eta_seconds === 0
              ? t("kpi.drain.empty")
              : t("kpi.drain.rate", { rate: formatRate(data?.throughput_per_second) })
          }
          tone={data?.drain_eta_seconds == null && (data?.backlog ?? 0) > 0 ? "warn" : "neutral"}
        />
        <KpiCard
          label={t("kpi.spot.label")}
          value={activeVms}
          unit={`/ ${target || "—"} / ${maxNodes || "—"}`}
          detail={
            data?.pool?.running
              ? t("kpi.spot.detail", {
                  ready: counters.ready ?? 0,
                  running: counters.busy ?? 0,
                  prov: counters.provisioning ?? 0,
                })
              : data?.pool
              ? t("kpi.spot.autostartOff")
              : "—"
          }
          tone={Number(counters.provisioning ?? 0) > 0 ? "warn" : "neutral"}
        />
      </div>

      <div className="grid-1">
        <ThroughputChart />
        <PoolPanel data={data} />
      </div>

      <BatchesTable />

      <NewBatchDialog open={dialogOpen} onClose={() => setDialogOpen(false)} />
    </>
  );
}
