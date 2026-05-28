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

export function ThroughputPage() {
  const summary = useOutletContext<UseQueryResult<DashboardSummary>>();
  const [dialogOpen, setDialogOpen] = useState(false);

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
          <h1>처리량 (Throughput)</h1>
          <div className="sub">
            백로그 · 풀 확장 속도 · 처리율을 한 화면에서 추적
          </div>
        </div>
        <div className="actions">
          <button
            className="btn"
            onClick={() => summary.refetch()}
            disabled={summary.isFetching}
          >
            ⟳ 새로고침
          </button>
          <button className="btn primary" onClick={() => setDialogOpen(true)}>
            ＋ 새 배치
          </button>
        </div>
      </div>

      {summary.isError && (
        <div className="error-banner" style={{ marginBottom: 16 }}>
          API 연결 실패 — 백엔드 (uvicorn) 가 떠 있는지 확인하세요.
        </div>
      )}

      <div className="kpis">
        <KpiCard
          label="backlog (pending requests)"
          value={formatNumber(data?.backlog ?? 0)}
          unit="req"
          detail={
            data
              ? `${data.active_batches} 활성 배치`
              : "—"
          }
        />
        <KpiCard
          label="throughput (1 min)"
          value={data ? data.throughput_per_second.toFixed(data.throughput_per_second >= 10 ? 0 : 1) : "—"}
          unit="req/s"
          detail={data?.latest_sample ? `샘플 ${data.latest_sample.active_batches}건 활성` : "—"}
        />
        <KpiCard
          label="drain ETA (현재 속도)"
          value={formatDuration(data?.drain_eta_seconds ?? null)}
          detail={
            data?.drain_eta_seconds == null && (data?.backlog ?? 0) > 0
              ? "처리율 0 — 워커 부족"
              : data?.drain_eta_seconds === 0
              ? "백로그 비어있음"
              : `처리율 ${formatRate(data?.throughput_per_second)}`
          }
          tone={data?.drain_eta_seconds == null && (data?.backlog ?? 0) > 0 ? "warn" : "neutral"}
        />
        <KpiCard
          label="spot vm (active / target / max)"
          value={activeVms}
          unit={`/ ${target || "—"} / ${maxNodes || "—"}`}
          detail={
            data?.pool?.running
              ? `ready ${counters.ready ?? 0} · running ${counters.busy ?? 0} · prov ${counters.provisioning ?? 0}`
              : "pool autostart disabled"
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
