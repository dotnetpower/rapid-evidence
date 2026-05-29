import { useI18n } from "../../lib/i18n";

export type BatchFilter = "all" | "active" | "terminal";
export type BatchSort = "newest" | "rate" | "evictions";

interface Props {
  filter: BatchFilter;
  onFilterChange: (next: BatchFilter) => void;
  sort: BatchSort;
  onSortChange: (next: BatchSort) => void;
  count: number;
  disabled?: boolean;
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
      }}
    >
      <span className="meta" style={{ fontFamily: "var(--mono)" }}>
        {t("batches.page.count", { n: count })}
      </span>
      <span className="toggle" role="group" aria-label="batch filter">
        {FILTERS.map((f) => (
          <button
            key={f.value}
            type="button"
            className={filter === f.value ? "on" : ""}
            onClick={() => onFilterChange(f.value)}
            aria-pressed={filter === f.value}
            disabled={disabled}
          >
            {t(f.key)}
          </button>
        ))}
      </span>
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
    </div>
  );
}
