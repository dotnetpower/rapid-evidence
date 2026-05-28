import { useI18n } from "../../lib/i18n";
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
}

type StatusKey = "ok" | "exhausted" | "error";

function probeStatus(p: RegionProbe): StatusKey {
  if (p.error) return "error";
  if ((p.headroom ?? 0) === 0) return "exhausted";
  return "ok";
}

function statusTone(s: StatusKey): string {
  if (s === "error") return "var(--bad, #e06c75)";
  if (s === "exhausted") return "var(--warn, #e6c47a)";
  return "var(--ok, #5db075)";
}

export function RegionQuotaTable({ probes, selected, onSelect }: RegionQuotaTableProps) {
  const { t } = useI18n();
  if (probes.length === 0) {
    return <div className="empty" style={{ padding: 16 }}>{t("regions.quotaTable.empty")}</div>;
  }
  // Sort: errors first (need attention), then exhausted, then by
  // headroom desc so the biggest headroom is most prominent.
  const sorted = [...probes].sort((a, b) => {
    const sa = probeStatus(a);
    const sb = probeStatus(b);
    const order = { error: 0, exhausted: 1, ok: 2 } as const;
    if (order[sa] !== order[sb]) return order[sa] - order[sb];
    return (b.headroom ?? -1) - (a.headroom ?? -1);
  });
  return (
    <table className="quota-table">
      <thead>
        <tr>
          <th style={{ textAlign: "left" }}>{t("regions.quotaTable.col.region")}</th>
          <th style={{ width: 110 }}>{t("regions.quotaTable.col.usage")}</th>
          <th>{t("regions.quotaTable.col.headroom")}</th>
          <th style={{ width: 100 }}>{t("regions.quotaTable.col.status")}</th>
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
          return (
            <tr
              key={p.region}
              className={isSel ? "selected" : ""}
              onClick={() => onSelect(isSel ? null : p.region)}
              style={{ cursor: "pointer" }}
              title={p.error ?? label}
            >
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
                  {t(`regions.quotaTable.status.${status}`)}
                </span>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
