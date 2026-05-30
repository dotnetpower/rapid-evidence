/**
 * Toolbar for the Regions page: search, sort, CSV export.
 *
 * Lives in its own file to keep RegionsPage under the 250-line SRP target.
 * State is owned by the parent; this component is a pure controlled input.
 */
import { useI18n } from "../../lib/i18n";
import { REGION_SORT_KEYS, type RegionSortKey } from "./regionFilter";

interface RegionsToolbarProps {
  query: string;
  onQuery: (next: string) => void;
  sort: RegionSortKey;
  onSort: (next: RegionSortKey) => void;
  onExport: () => void;
  exportDisabled: boolean;
  matchCount: number;
  totalCount: number;
}

export function RegionsToolbar({
  query,
  onQuery,
  sort,
  onSort,
  onExport,
  exportDisabled,
  matchCount,
  totalCount,
}: RegionsToolbarProps) {
  const { t } = useI18n();
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "6px 12px 4px 12px",
        flexWrap: "wrap",
      }}
    >
      <label className="toolbar-search" aria-label={t("common.search")}>
        <span aria-hidden>⌕</span>
        <input
          type="search"
          value={query}
          placeholder={t("regions.search.placeholder")}
          onChange={(e) => onQuery(e.target.value)}
        />
        {query && (
          <button
            className="clear"
            onClick={() => onQuery("")}
            title={t("common.clear")}
            aria-label={t("common.clear")}
          >
            ×
          </button>
        )}
      </label>
      <label style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 12 }}>
        <span style={{ color: "var(--text-muted)" }}>{t("common.sortBy")}:</span>
        <select
          value={sort}
          onChange={(e) => onSort(e.target.value as RegionSortKey)}
          aria-label={t("common.sortBy")}
        >
          {REGION_SORT_KEYS.map((k) => (
            <option key={k} value={k}>
              {t(`regions.sort.${k}`)}
            </option>
          ))}
        </select>
      </label>
      <button
        className="btn"
        onClick={onExport}
        disabled={exportDisabled}
        title={t("common.exportCsv")}
      >
        ⇩ CSV
      </button>
      <span style={{ marginLeft: "auto", fontSize: 11, color: "var(--text-muted)" }}>
        {query
          ? t("regions.search.matchCount", { n: matchCount, total: totalCount })
          : t("regions.search.total", { n: totalCount })}
      </span>
    </div>
  );
}
