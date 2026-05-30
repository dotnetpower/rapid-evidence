/**
 * Single row in the throughput-page `BatchesTable`.
 *
 * Extracted from `BatchesTable.tsx` so the parent stays under the
 * 300-line SRP ceiling and so each concern (data fetch + selection
 * vs. per-row presentation) lives in its own file.
 *
 * Pure presentation: receives selection + cancel hooks via props; no
 * own query state, no own router state.
 */
import { useI18n } from "../lib/i18n";
import type { BatchProgress, BatchStatus } from "../lib/api";
import { formatDuration, formatNumber, formatPercent, formatRate } from "../lib/format";

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

interface Props {
  batch: BatchProgress;
  checked: boolean;
  cancellable: boolean;
  /** True if a cancel mutation is in flight (disables actions). */
  cancelPending: boolean;
  onToggle: (id: string) => void;
  onCancel: (id: string) => void;
}

export function BatchesTableRow({
  batch: b,
  checked,
  cancellable,
  cancelPending,
  onToggle,
  onCancel,
}: Props) {
  const { t } = useI18n();
  const evObs = Number(
    (b.metadata && (b.metadata as Record<string, unknown>).evictions_observed) ?? 0,
  );
  const nodeCounts = (b.metadata?.node_counts ?? {}) as Record<string, number>;
  const nodeIds = Object.keys(nodeCounts);

  return (
    <tr className={checked ? "row-selected" : ""}>
      <td>
        <input
          type="checkbox"
          aria-label={t("batches.table.bulkBar.ariaCheck", { id: b.batch_id })}
          checked={checked}
          disabled={!cancellable}
          onChange={() => onToggle(b.batch_id)}
        />
      </td>
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
              title={nodeIds.map((id) => `${id}: ${nodeCounts[id]}`).join("\n")}
              style={{ marginLeft: 6, opacity: 0.6 }}
            >
              · {t(
                nodeIds.length === 1 ? "batches.nodes" : "batches.nodes_plural",
                { n: nodeIds.length },
              )}
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
          onClick={() => onCancel(b.batch_id)}
          disabled={!cancellable || cancelPending}
          title={t("batches.cancel")}
        >
          ✕
        </button>
      </td>
    </tr>
  );
}

export function isCancellableBatch(b: BatchProgress): boolean {
  return !TERMINAL_STATES.includes(b.status);
}
