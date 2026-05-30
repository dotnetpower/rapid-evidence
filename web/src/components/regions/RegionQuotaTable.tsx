import { useI18n } from "../../lib/i18n";
import { timeAgoLocalized } from "../../lib/format";
import { REGION_GEO } from "./regionGeo";

export interface RegionProbe {
  region: string;
  used: number | null;
  limit: number | null;
  headroom: number | null;
  observed: boolean;
  error: string | null;
}

interface RegionQuotaTableProps {
  probes: RegionProbe[];
  selected: string | null;
  onSelect: (region: string | null) => void;
  /** Timestamp (ISO) of the latest probe scan. Shared across all rows since
   * a single `azure-region-quota-scan` job covers every region in one pass. */
  lastScanAt?: string | null;
  /** Current wall-clock ms, normally driven by `useNowTick` so the relative
   * "X초 전" label re-renders on a 1s cadence. */
  nowMs?: number;  /** Pinned regions (sorted to the top by the parent). Optional so this
   * component stays usable in places that don't need favorites yet. */
  favorites?: ReadonlySet<string>;
  onToggleFavorite?: (region: string) => void;}

type StatusKey = "ok" | "exhausted" | "error";

function probeStatus(p: RegionProbe): StatusKey {
  if (p.error) return "error";
  if ((p.headroom ?? 0) === 0) return "exhausted";
  return "ok";
}

function statusIcon(s: StatusKey): string {
  if (s === "error") return "✕";
  if (s === "exhausted") return "⚠";
  return "✓";
}

function statusTone(s: StatusKey): string {
  if (s === "error") return "var(--bad, #e06c75)";
  if (s === "exhausted") return "var(--warn, #e6c47a)";
  return "var(--ok, #5db075)";
}

export function RegionQuotaTable({
  probes,
  selected,
  onSelect,
  lastScanAt = null,
  nowMs,
  favorites,
  onToggleFavorite,
}: RegionQuotaTableProps) {
  const { t, lang } = useI18n();
  if (probes.length === 0) {
    return <div className="empty" style={{ padding: 16 }}>{t("regions.quotaTable.empty")}</div>;
  }
  const checkedLabel = lastScanAt
    ? t("regions.quotaTable.checkedAgo", {
        ago: timeAgoLocalized(lastScanAt, nowMs ?? Date.now(), lang),
      })
    : t("regions.quotaTable.neverChecked");
  // Parent sorts now; this component preserves caller order so the
  // toolbar's sort/favorites choices are respected.
  const sorted = probes;
  const showFav = !!onToggleFavorite;
  return (
    <table className="quota-table">
      <thead>
        <tr>
          {showFav && <th style={{ width: 28 }} aria-label={t("common.pin")} />}
          <th style={{ textAlign: "left" }}>{t("regions.quotaTable.col.region")}</th>
          <th style={{ width: 110 }}>{t("regions.quotaTable.col.usage")}</th>
          <th>{t("regions.quotaTable.col.headroom")}</th>
          <th style={{ width: 120 }}>{t("regions.quotaTable.col.status")}</th>
        </tr>
      </thead>
      <tbody>
        {sorted.map((p) => {
          const usagePct =
            p.limit && p.limit > 0 && p.used !== null
              ? Math.min(100, Math.max(0, (p.used / p.limit) * 100))
              : 0;
          const status = probeStatus(p);
          const isSel = selected === p.region;
          const label = REGION_GEO[p.region]?.label ?? p.region;
          const isFav = favorites?.has(p.region) ?? false;
          return (
            <tr
              key={p.region}
              className={isSel ? "selected" : ""}
              onClick={() => onSelect(isSel ? null : p.region)}
              style={{ cursor: "pointer" }}
              title={p.error ?? label}
            >
              {showFav && (
                <td onClick={(e) => e.stopPropagation()}>
                  <button
                    type="button"
                    className={`fav-btn${isFav ? " on" : ""}`}
                    onClick={() => onToggleFavorite?.(p.region)}
                    aria-label={isFav ? t("common.unpin") : t("common.pin")}
                    title={isFav ? t("common.unpin") : t("common.pin")}
                  >
                    {isFav ? "★" : "☆"}
                  </button>
                </td>
              )}
              <td>
                <div style={{ fontFamily: "monospace", fontSize: 12 }}>{p.region}</div>
                <div style={{ fontSize: 10, opacity: 0.6 }}>{label}</div>
              </td>
              <td style={{ whiteSpace: "nowrap" }}>
                {p.observed
                  ? `${p.used ?? "—"} / ${p.limit ?? "—"}`
                  : "—"}
              </td>
              <td>
                <div className="quota-bar" title={`${usagePct.toFixed(0)}%`}>
                  <div
                    className="quota-bar__fill"
                    style={{ width: `${usagePct}%`, background: statusTone(status) }}
                  />
                </div>
                <div style={{ fontSize: 11, marginTop: 2 }}>
                  {p.headroom !== null ? p.headroom : "—"}
                </div>
              </td>
              <td>
                <span
                  className={`pill status-${status}`}
                  style={{ color: statusTone(status), borderColor: statusTone(status) }}
                  title={p.error ?? undefined}
                >
                  <span aria-hidden="true" style={{ marginRight: 4 }}>{statusIcon(status)}</span>
                  {t(`regions.quotaTable.status.${status}`)}
                </span>
                <div
                  className="quota-table__checked"
                  style={{ fontSize: 10, opacity: 0.6, marginTop: 4 }}
                  title={lastScanAt ?? undefined}
                >
                  {checkedLabel}
                </div>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
