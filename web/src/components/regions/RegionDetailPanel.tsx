/**
 * Detail panel for a selected region on the Regions page.
 *
 * Split out of RegionsPage to keep that file under the 300-line ceiling
 * (see .github/copilot-instructions.md §7). Pure presentational — no
 * data fetching of its own.
 */
import type { PoolNodeSnapshot } from "../../lib/api";
import { useI18n } from "../../lib/i18n";
import type { RegionProbe } from "./RegionQuotaTable";

interface RegionDetailPanelProps {
  selected: string;
  nodes: PoolNodeSnapshot[];
  probe: RegionProbe | null;
}

export function RegionDetailPanel({
  selected,
  nodes,
  probe,
}: RegionDetailPanelProps) {
  const { t } = useI18n();
  const regionLabel =
    selected === "__unknown__" ? t("regions.unknown") : selected;
  return (
    <div className="panel" style={{ marginTop: 16 }}>
      <div className="panel-head">
        <span className="title">
          {t("regions.nodes_detail", { region: regionLabel })}
        </span>
        <span className="meta">
          {probe?.observed
            ? `${probe.used ?? "—"}/${probe.limit ?? "—"} · headroom ${probe.headroom ?? "—"}`
            : `${nodes.length}`}
        </span>
      </div>
      {probe?.error && (
        <div
          className="info-banner"
          style={{ margin: 12, color: "var(--bad, #e06c75)" }}
        >
          {probe.error}
        </div>
      )}
      {nodes.length === 0 ? (
        <div className="empty" style={{ padding: 16, opacity: 0.7 }}>
          {t("regions.empty")}
        </div>
      ) : (
        <table className="batches">
          <thead>
            <tr>
              <th style={{ width: "30%" }}>{t("regions.col.id")}</th>
              <th style={{ width: "20%" }}>{t("regions.col.state")}</th>
              <th>{t("regions.col.outbound")}</th>
            </tr>
          </thead>
          <tbody>
            {nodes.map((n) => (
              <tr key={n.node_id}>
                <td className="id-cell">
                  <div className="id">{n.node_id}</div>
                  <div className="src" style={{ opacity: 0.6 }}>
                    {n.name}
                  </div>
                </td>
                <td>
                  <span className={`pill state-${n.state}`}>{n.state}</span>
                </td>
                <td
                  style={{
                    fontFamily: "monospace",
                    opacity: n.outbound_ip ? 1 : 0.4,
                  }}
                >
                  {n.outbound_ip ?? "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
