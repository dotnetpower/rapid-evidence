import { useI18n } from "../../lib/i18n";

export type BatchFilter = "all" | "active" | "terminal";
export type BatchSort = "newest" | "rate" | "evictions";

export interface BatchFilterCounts {
  all: number;
  active: number;
  terminal: number;
}

interface Props {
  filter: BatchFilter;
  onFilterChange: (next: BatchFilter) => void;
  sort: BatchSort;
  onSortChange: (next: BatchSort) => void;
  count: number;
  disabled?: boolean;
  /** Counts shown next to each chip; defaults to 0 if omitted. */
  counts?: BatchFilterCounts;
  /** Controlled search query — filters by id/source/status substring. */
  query?: string;
  onQueryChange?: (next: string) => void;
  /** Optional CSV export trigger; button hidden when undefined. */
  onExport?: () => void;
  exportDisabled?: boolean;
}

const FILTERS: { value: BatchFilter; key: string }[] = [
  { value: "all", key: "batches.filter.all" },
  { value: "active", key: "batches.filter.active" },
  { value: "terminal", key: "batches.filter.terminal" },
];

export function BatchFilterBar({
  filter,
  onFilterChange,
  sort,
  onSortChange,
  count,
  disabled = false,
  counts,
  query,
  onQueryChange,
  onExport,
  exportDisabled,
}: Props) {
  const { t } = useI18n();
  return (
    <div
      className="panel-head"
      style={{
        borderRadius: 8,
        border: "1px solid var(--border)",
        marginBottom: 12,
        opacity: disabled ? 0.6 : 1,
        flexWrap: "wrap",
        gap: 8,
      }}
    >
      <span className="meta" style={{ fontFamily: "var(--mono)" }}>
        {t("batches.page.count", { n: count })}
      </span>
      <span className="toggle" role="group" aria-label="batch filter">
        {FILTERS.map((f) => {
          const n = counts ? counts[f.value] : null;
          return (
            <button
              key={f.value}
              type="button"
              className={filter === f.value ? "on" : ""}
              onClick={() => onFilterChange(f.value)}
              aria-pressed={filter === f.value}
              disabled={disabled}
              title={n !== null ? String(n) : undefined}
            >
              {t(f.key)}
              {n !== null && (
                <span style={{ opacity: 0.6, marginLeft: 4, fontVariantNumeric: "tabular-nums" }}>
                  · {n}
                </span>
              )}
            </button>
          );
        })}
      </span>
      {onQueryChange && (
        <label className="toolbar-search" aria-label={t("common.search")}>
          <span aria-hidden>⌕</span>
          <input
            type="search"
            value={query ?? ""}
            placeholder={t("batches.table.search.placeholder")}
            onChange={(e) => onQueryChange(e.target.value)}
            disabled={disabled}
          />
          {query && (
            <button
              className="clear"
              onClick={() => onQueryChange("")}
              title={t("common.clear")}
              aria-label={t("common.clear")}
            >
              ×
            </button>
          )}
        </label>
      )}
      <label style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
        <span style={{ fontSize: 11, color: "var(--text-muted)" }}>
          {t("batches.sort.label")}
        </span>
        <select
          value={sort}
          onChange={(e) => onSortChange(e.target.value as BatchSort)}
          disabled={disabled}
          style={{
            background: "var(--bg-app)",
            color: "var(--text)",
            border: "1px solid var(--border-strong)",
            borderRadius: 4,
            padding: "3px 8px",
            fontSize: 12,
          }}
        >
          <option value="newest">{t("batches.sort.newest")}</option>
          <option value="rate">{t("batches.sort.rate")}</option>
          <option value="evictions">{t("batches.sort.evictions")}</option>
        </select>
      </label>
      {onExport && (
        <button
          type="button"
          className="btn"
          onClick={onExport}
          disabled={!!exportDisabled || disabled}
          title={t("common.exportCsv")}
        >
          ⇩ CSV
        </button>
      )}
    </div>
  );
}

