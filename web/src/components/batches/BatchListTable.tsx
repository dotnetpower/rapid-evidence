import { type BatchProgress, type BatchStatus } from "../../lib/api";
import { formatNumber, formatPercent, formatRate, timeAgo } from "../../lib/format";
import { useI18n } from "../../lib/i18n";

interface Props {
  rows: BatchProgress[];
  selectedId: string | null;
  onSelect: (batchId: string) => void;
}

function meterColor(status: BatchStatus): string {
  switch (status) {
    case "paused":
      return "warn";
    case "queued":
      return "";
    case "done":
      return "ok";
    case "failed":
      return "warn";
    case "cancelled":
      return "";
    default:
      return "violet";
  }
}

function nodeCount(b: BatchProgress): number {
  const nc = (b.metadata?.node_counts ?? {}) as Record<string, number>;
  return Object.keys(nc).length;
}

function evictionCount(b: BatchProgress): number {
  return Number((b.metadata as Record<string, unknown>)?.evictions_observed ?? 0);
}

export function BatchListTable({ rows, selectedId, onSelect }: Props) {
  const { t } = useI18n();
  if (rows.length === 0) {
    return <div className="empty">{t("batches.list.empty")}</div>;
  }
  return (
    <section className="panel">
      <table className="batches">
        <thead>
          <tr>
            <th style={{ width: "26%" }}>{t("batches.list.col.batch")}</th>
            <th style={{ width: 110 }}>{t("batches.list.col.source")}</th>
            <th style={{ width: 90 }}>{t("batches.list.col.status")}</th>
            <th>{t("batches.list.col.progress")}</th>
            <th style={{ width: 90 }}>{t("batches.list.col.rate")}</th>
            <th style={{ width: 80 }}>{t("batches.list.col.workers")}</th>
            <th style={{ width: 70 }}>{t("batches.list.col.nodes")}</th>
            <th style={{ width: 80 }}>{t("batches.list.col.evictions")}</th>
            <th style={{ width: 110 }}>{t("batches.list.col.created")}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((b) => {
            const isSelected = selectedId === b.batch_id;
            return (
              <tr
                key={b.batch_id}
                onClick={() => onSelect(b.batch_id)}
                style={{
                  cursor: "pointer",
                  background: isSelected ? "var(--accent-soft)" : undefined,
                }}
              >
                <td className="name id-cell">
                  <div className="id">{b.batch_id}</div>
                </td>
                <td>{b.source}</td>
                <td>
                  <span className={`tag ${b.status}`}>{b.status}</span>
                </td>
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
                  {b.workers_active}/{b.workers_target}
                </td>
                <td>{formatNumber(nodeCount(b))}</td>
                <td>
                  {evictionCount(b) > 0 ? (
                    <span style={{ color: "#e6c47a" }}>⚠ {evictionCount(b)}</span>
                  ) : (
                    "—"
                  )}
                </td>
                <td>{timeAgo(b.created_at)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </section>
  );
}
