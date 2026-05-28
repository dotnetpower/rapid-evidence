import { useEffect } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError, api, type BatchProgress } from "../../lib/api";
import {
  formatDuration,
  formatNumber,
  formatPercent,
  formatRate,
} from "../../lib/format";
import { useI18n } from "../../lib/i18n";
import { BatchTimelineList } from "./BatchTimelineList";

const TERMINAL_STATES = new Set(["done", "cancelled", "failed"]);

interface Props {
  batchId: string;
  onClose: () => void;
}

function nodeCounts(b: BatchProgress | undefined): Record<string, number> {
  return (b?.metadata?.node_counts ?? {}) as Record<string, number>;
}

function evictedRequestIds(b: BatchProgress | undefined): string[] {
  const raw = (b?.metadata as Record<string, unknown> | undefined)?.evicted_request_ids;
  return Array.isArray(raw) ? (raw as string[]) : [];
}

function evictionsObserved(b: BatchProgress | undefined): number {
  return Number((b?.metadata as Record<string, unknown> | undefined)?.evictions_observed ?? 0);
}

export function BatchDetailDrawer({ batchId, onClose }: Props) {
  const { t } = useI18n();
  const queryClient = useQueryClient();

  const batchQuery = useQuery<BatchProgress, ApiError>({
    queryKey: ["batch-detail", batchId],
    queryFn: async () => {
      const list = await api.listBatches();
      const found = list.batches.find((b) => b.batch_id === batchId);
      if (!found) {
        throw new ApiError(404, "batch not found");
      }
      return found;
    },
    refetchInterval: 2000,
    staleTime: 1500,
  });

  const timelineQuery = useQuery({
    queryKey: ["batch-timeline", batchId],
    queryFn: () => api.batchTimeline(batchId),
    refetchInterval: 2000,
    staleTime: 1500,
  });

  const cancelMut = useMutation({
    mutationFn: () => api.cancelBatch(batchId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["batches"] });
      queryClient.invalidateQueries({ queryKey: ["batch-detail", batchId] });
      queryClient.invalidateQueries({ queryKey: ["batch-timeline", batchId] });
    },
  });

  useEffect(() => {
    function onEsc(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onEsc);
    return () => window.removeEventListener("keydown", onEsc);
  }, [onClose]);

  const batch = batchQuery.data;
  const notFound = batchQuery.isError && (batchQuery.error as ApiError)?.status === 404;
  const counts = nodeCounts(batch);
  const totalNodeReqs = Object.values(counts).reduce((a, b) => a + b, 0);
  const evicted = evictedRequestIds(batch);
  const observed = evictionsObserved(batch);
  const canCancel = batch ? !TERMINAL_STATES.has(batch.status) : false;

  return (
    <>
      <div className="drawer-backdrop" onClick={onClose} aria-hidden="true" />
      <aside className="drawer" role="dialog" aria-label={t("batches.drawer.title")}>
        <div className="drawer-panel">
          <header>
            <div>
              <div className="id">{batchId}</div>
              <div className="src">
                {batch ? batch.source : "—"}
                {batch && (
                  <span className={`tag ${batch.status}`} style={{ marginLeft: 8 }}>
                    {batch.status}
                  </span>
                )}
              </div>
            </div>
            <button
              type="button"
              className="icon-btn"
              onClick={onClose}
              title={t("batches.drawer.close")}
            >
              ✕
            </button>
          </header>

          <div className="body">
            {notFound && (
              <div className="error-banner">{t("batches.drawer.notFound")}</div>
            )}

            <section className="drawer-section">
              <h3>{t("batches.drawer.summary")}</h3>
              <dl className="drawer-kpis">
                <dt>{t("batches.drawer.summary.total")}</dt>
                <dd>{formatNumber(batch?.total)}</dd>
                <dt>{t("batches.drawer.summary.completed")}</dt>
                <dd>{formatNumber(batch?.completed)}</dd>
                <dt>{t("batches.drawer.summary.failed")}</dt>
                <dd>{formatNumber(batch?.failed)}</dd>
                <dt>{t("batches.drawer.summary.pending")}</dt>
                <dd>{formatNumber(batch?.pending)}</dd>
                <dt>{t("batches.drawer.summary.rate")}</dt>
                <dd>{formatRate(batch?.throughput_per_second)}</dd>
                <dt>{t("batches.drawer.summary.eta")}</dt>
                <dd>{formatDuration(batch?.eta_seconds ?? null)}</dd>
                <dt>{t("batches.drawer.summary.workers")}</dt>
                <dd>
                  {batch ? `${batch.workers_active}/${batch.workers_target}` : "—"}
                </dd>
                <dt>%</dt>
                <dd>{formatPercent(batch?.percent)}</dd>
              </dl>
            </section>

            <section className="drawer-section">
              <h3>{t("batches.drawer.nodes")}</h3>
              {Object.keys(counts).length === 0 ? (
                <div className="empty" style={{ padding: 12 }}>
                  {t("batches.drawer.nodes.empty")}
                </div>
              ) : (
                <table className="batches" style={{ fontSize: 12 }}>
                  <thead>
                    <tr>
                      <th>{t("batches.drawer.nodes.col.node")}</th>
                      <th style={{ width: 80 }}>{t("batches.drawer.nodes.col.count")}</th>
                      <th style={{ width: 80 }}>{t("batches.drawer.nodes.col.share")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {Object.entries(counts)
                      .sort((a, b) => b[1] - a[1])
                      .map(([nodeId, count]) => (
                        <tr key={nodeId}>
                          <td style={{ fontFamily: "var(--mono)", fontSize: 11 }}>
                            {nodeId}
                          </td>
                          <td>{formatNumber(count)}</td>
                          <td>
                            {totalNodeReqs > 0
                              ? formatPercent((count / totalNodeReqs) * 100)
                              : "—"}
                          </td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              )}
            </section>

            <section className="drawer-section">
              <h3>{t("batches.drawer.evictions")}</h3>
              {observed === 0 && evicted.length === 0 ? (
                <div className="empty" style={{ padding: 12 }}>
                  {t("batches.drawer.evictions.empty")}
                </div>
              ) : (
                <>
                  <div style={{ fontSize: 12, marginBottom: 6, color: "#e6c47a" }}>
                    ⚠ {t("batches.drawer.evictions.observed", { n: observed })}
                  </div>
                  {evicted.length > 0 && (
                    <>
                      <div style={{ fontSize: 11, color: "var(--text-muted)" }}>
                        {t("batches.drawer.evictions.requestIds")}
                      </div>
                      <ul className="drawer-list">
                        {evicted.map((rid) => (
                          <li key={rid}>{rid}</li>
                        ))}
                      </ul>
                    </>
                  )}
                </>
              )}
            </section>

            <section className="drawer-section">
              <h3>{t("batches.drawer.timeline")}</h3>
              <BatchTimelineList
                events={timelineQuery.data?.events}
                isLoading={timelineQuery.isLoading}
              />
            </section>
          </div>

          <footer>
            <button
              type="button"
              className="btn"
              onClick={() => cancelMut.mutate()}
              disabled={!canCancel || cancelMut.isPending}
              title={t("batches.drawer.cancel")}
            >
              {t("batches.drawer.cancel")}
            </button>
          </footer>
        </div>
      </aside>
    </>
  );
}
