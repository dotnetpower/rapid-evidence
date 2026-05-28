import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, type DashboardSummary } from "../lib/api";
import { useI18n } from "../lib/i18n";
import { RegionCard } from "../components/regions/RegionCard";
import "../styles/quota-regions.css";

export function RegionsPage() {
  const { t } = useI18n();
  const [selected, setSelected] = useState<string | null>(null);

  const regions = useQuery({
    queryKey: ["regions-status"],
    queryFn: () => api.regionsStatus(),
    refetchInterval: 5000,
    staleTime: 3000,
  });
  const summary = useQuery({
    queryKey: ["dashboard-summary"],
    queryFn: () => api.dashboardSummary(),
    refetchInterval: 5000,
  });

  const rows = regions.data?.regions ?? [];
  const nodes = (summary.data as DashboardSummary | undefined)?.pool?.nodes ?? [];

  const selectedNodes = useMemo(() => {
    if (selected === null) return [];
    return nodes.filter((n) => {
      const meta = (n as { metadata?: { region?: string } }).metadata ?? {};
      const region = meta.region ?? null;
      if (selected === "__unknown__") return region == null;
      return region === selected;
    });
  }, [nodes, selected]);

  return (
    <>
      <div className="page-head">
        <div>
          <h1>{t("regions.page.title")}</h1>
          <div className="sub">{t("regions.page.sub")}</div>
        </div>
      </div>

      {rows.length === 0 ? (
        <div className="panel">
          <div className="empty">{t("regions.empty")}</div>
        </div>
      ) : (
        <>
          <div className="region-grid">
            {rows.map((row) => {
              const key = row.region ?? "__unknown__";
              return (
                <RegionCard
                  key={key}
                  summary={row}
                  selected={selected === key}
                  onClick={() => setSelected((prev) => (prev === key ? null : key))}
                />
              );
            })}
          </div>
          {selected === null ? (
            <div className="empty" style={{ opacity: 0.6, padding: 16 }}>
              {t("regions.click_hint")}
            </div>
          ) : (
            <div className="panel" style={{ marginTop: 16 }}>
              <div className="panel-head">
                <span className="title">
                  {t("regions.nodes_detail", {
                    region: selected === "__unknown__" ? t("regions.unknown") : selected,
                  })}
                </span>
                <span className="meta">{selectedNodes.length}</span>
              </div>
              <table className="batches">
                <thead>
                  <tr>
                    <th style={{ width: "30%" }}>{t("regions.col.id")}</th>
                    <th style={{ width: "20%" }}>{t("regions.col.state")}</th>
                    <th>{t("regions.col.outbound")}</th>
                  </tr>
                </thead>
                <tbody>
                  {selectedNodes.map((n) => (
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
                      <td style={{ fontFamily: "monospace", opacity: n.outbound_ip ? 1 : 0.4 }}>
                        {n.outbound_ip ?? "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </>
  );
}
