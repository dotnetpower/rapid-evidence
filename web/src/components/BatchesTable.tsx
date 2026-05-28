import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type BatchProgress, type BatchStatus } from "../lib/api";
import { formatDuration, formatNumber, formatPercent, formatRate } from "../lib/format";
import { useI18n } from "../lib/i18n";

const TERMINAL_STATES: BatchStatus[] = ["done", "cancelled", "failed"];

function meterColor(status: BatchStatus): string {
  switch (status) {
    case "paused": return "warn";
    case "queued": return "";
    case "done": return "ok";
    case "failed": return "warn";
    case "cancelled": return "";
    default: return "violet";
  }
}

export function BatchesTable() {
  const queryClient = useQueryClient();
  const { t } = useI18n();
  const batches = useQuery({
    queryKey: ["batches"],
    queryFn: () => api.listBatches().then((r) => r.batches),
    refetchInterval: 2000,
    staleTime: 1500,
  });

  const cancelMut = useMutation({
    mutationFn: (id: string) => api.cancelBatch(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["batches"] }),
  });

  const rows: BatchProgress[] = batches.data ?? [];

  return (
    <section className="panel">
      <div className="panel-head">
        <span className="title">{t("batches.title", { n: rows.length })}</span>
        <span className="meta">{t("batches.meta")}</span>
      </div>
      {rows.length === 0 ? (
        <div className="empty">
          {batches.isLoading
            ? t("batches.empty.loading")
            : t("batches.empty.none")}
        </div>
      ) : (
        <table className="batches">
          <thead>
            <tr>
              <th style={{ width: "28%" }}>{t("batches.col.batch")}</th>
              <th style={{ width: 80 }}>{t("batches.col.requests")}</th>
              <th>{t("batches.col.progress")}</th>
              <th style={{ width: 90 }}>{t("batches.col.rate")}</th>
              <th style={{ width: 100 }}>{t("batches.col.eta")}</th>
              <th style={{ width: 70 }}>{t("batches.col.workers")}</th>
              <th style={{ width: 90 }}>{t("batches.col.status")}</th>
              <th style={{ width: 90, textAlign: "right" }}>{t("batches.col.actions")}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((b) => {
              const evObs = Number(
                (b.metadata && (b.metadata as Record<string, unknown>).evictions_observed) ?? 0
              );
              const nodeCounts = (b.metadata?.node_counts ?? {}) as Record<string, number>;
              const nodeIds = Object.keys(nodeCounts);
              return (
              <tr key={b.batch_id}>
                <td className="name id-cell">
                  <div className="id">{b.batch_id}</div>
                  <div className="src">
                    {b.source}
                    {evObs > 0 && (
                      <span
                        title={t("batches.evictTooltip", { n: evObs })}
                        style={{ marginLeft: 6, color: "#e6c47a" }}
                      >
                        ⚠ {evObs}
                      </span>
                    )}
                    {nodeIds.length > 0 && (
                      <span
                        title={nodeIds
                          .map((id) => `${id}: ${nodeCounts[id]}`)
                          .join("\n")}
                        style={{ marginLeft: 6, opacity: 0.6 }}
                      >
                        · {t(nodeIds.length === 1 ? "batches.nodes" : "batches.nodes_plural", {
                          n: nodeIds.length,
                        })}
                      </span>
                    )}
                  </div>
                </td>
                <td>{formatNumber(b.total)}</td>
                <td>
                  <div className="prog">
                    <div className={`meter ${meterColor(b.status)}`}>
                      <span style={{ width: `${b.percent}%` }} />
                    </div>
                    <span className="pct">{formatPercent(b.percent)}</span>
                  </div>
                </td>
                <td>{formatRate(b.throughput_per_second)}</td>
                <td>
                  {b.status === "done"
                    ? t("batches.status.done")
                    : b.status === "cancelled"
                    ? t("batches.status.cancelled")
                    : b.status === "failed"
                    ? t("batches.status.failed")
                    : formatDuration(b.eta_seconds)}
                </td>
                <td>
                  {b.workers_active}/{b.workers_target}
                </td>
                <td>
                  <span className={`tag ${b.status}`}>{b.status}</span>
                </td>
                <td className="row-act">
                  <button
                    className="icon-btn"
                    onClick={() => cancelMut.mutate(b.batch_id)}
                    disabled={TERMINAL_STATES.includes(b.status) || cancelMut.isPending}
                    title={t("batches.cancel")}
                  >
                    ✕
                  </button>
                </td>
              </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </section>
  );
}
