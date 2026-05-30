import { memo, useCallback } from "react";
import { type BatchProgress, type BatchStatus } from "../../lib/api";
import { formatNumber, formatPercent, formatRate, timeAgo } from "../../lib/format";

/**
 * Single row inside `BatchListTable`. Extracted + memoised because the
 * parent re-renders every 2 s (polling `/batches`); without memoisation
 * every row reconciles even when only a couple of rows changed, which
 * dominates frame time once the batch count climbs.
 *
 * `onSelect` is the parent's callback. Consumers must pass a stable
 * reference (already true: `onSelect` in `BatchListTable` is the page's
 * navigate handler, identity-stable per render). We additionally close
 * over `batch_id` with a `useCallback` so the inner click handler is
 * stable across renders for the same row.
 */

interface BatchListRowProps {
  row: BatchProgress;
  isSelected: boolean;
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

function BatchListRowImpl({ row, isSelected, onSelect }: BatchListRowProps) {
  const handleClick = useCallback(
    () => onSelect(row.batch_id),
    [onSelect, row.batch_id],
  );
  const evictions = evictionCount(row);
  return (
    <tr
      onClick={handleClick}
      style={{
        cursor: "pointer",
        background: isSelected ? "var(--accent-soft)" : undefined,
      }}
    >
      <td className="name id-cell">
        <div className="id">{row.batch_id}</div>
      </td>
      <td>{row.source}</td>
      <td>
        <span className={`tag ${row.status}`}>{row.status}</span>
      </td>
      <td>
        <div className="prog">
          <div className={`meter ${meterColor(row.status)}`}>
            <span style={{ width: `${row.percent}%` }} />
          </div>
          <span className="pct">{formatPercent(row.percent)}</span>
        </div>
      </td>
      <td>{formatRate(row.throughput_per_second)}</td>
      <td>
        {row.workers_active}/{row.workers_target}
      </td>
      <td>{formatNumber(nodeCount(row))}</td>
      <td>
        {evictions > 0 ? (
          <span style={{ color: "#e6c47a" }}>⚠ {evictions}</span>
        ) : (
          "—"
        )}
      </td>
      <td>{timeAgo(row.created_at)}</td>
    </tr>
  );
}

export const BatchListRow = memo(BatchListRowImpl);
