import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, type DashboardSummary, type BackgroundJob } from "../lib/api";
import { useI18n } from "../lib/i18n";
import { RegionCard } from "../components/regions/RegionCard";
import { RegionsMap } from "../components/regions/RegionsMap";
import "../styles/quota-regions.css";

type ViewMode = "map" | "cards";

interface RegionProbe {
  region: string;
  used: number | null;
  limit: number | null;
  headroom: number | null;
  observed: boolean;
  error: string | null;
}

function extractRegionProbes(jobs: BackgroundJob[]): Record<string, RegionProbe> {
  const out: Record<string, RegionProbe> = {};
  const sorted = [...jobs].sort((a, b) =>
    (b.finished_at ?? b.started_at).localeCompare(a.finished_at ?? a.started_at),
  );
  const latest = sorted.find(
    (j) => j.name === "azure-region-quota-scan" && j.status === "succeeded" && j.result,
  );
  if (!latest || !latest.result) return out;
  const result = latest.result as { regions?: unknown };
  const regions = Array.isArray(result.regions) ? result.regions : [];
  for (const r of regions) {
    if (!r || typeof r !== "object") continue;
    const rec = r as Record<string, unknown>;
    const region = typeof rec.region === "string" ? rec.region : null;
    if (!region) continue;
    out[region] = {
      region,
      used: typeof rec.used === "number" ? rec.used : null,
      limit: typeof rec.limit === "number" ? rec.limit : null,
      headroom: typeof rec.headroom === "number" ? rec.headroom : null,
      observed: rec.observed === true,
      error: typeof rec.error === "string" ? rec.error : null,
    };
  }
  return out;
}

export function RegionsPage() {
  const { t } = useI18n();
  const [selected, setSelected] = useState<string | null>(null);
  const [view, setView] = useState<ViewMode>("map");

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
  const jobs = useQuery({
    queryKey: ["jobs", "regions-page"],
    queryFn: () => api.jobsList(50),
    refetchInterval: 10000,
    staleTime: 5000,
  });

  const rows = regions.data?.regions ?? [];
  const nodes = (summary.data as DashboardSummary | undefined)?.pool?.nodes ?? [];
  const quotaByRegion = useMemo(
    () => extractRegionProbes(jobs.data?.jobs ?? []),
    [jobs.data],
  );

  const selectedNodes = useMemo(() => {
    if (selected === null) return [];
    return nodes.filter((n) => {
      const meta = (n as { metadata?: { region?: string } }).metadata ?? {};
      const region = meta.region ?? null;
      if (selected === "__unknown__") return region == null;
      return region === selected;
    });
  }, [nodes, selected]);

  const showProbeHint =
    view === "map" && Object.keys(quotaByRegion).length === 0;

  return (
    <>
      <div className="page-head">
        <div>
          <h1>{t("regions.page.title")}</h1>
          <div className="sub">{t("regions.page.sub")}</div>
        </div>
        <div className="actions">
          <div className="btn-group" role="group" aria-label="view mode">
            <button
              type="button"
              className={`btn ${view === "map" ? "primary" : ""}`}
              onClick={() => setView("map")}
            >
              {t("regions.map.toggle_map")}
            </button>
            <button
              type="button"
              className={`btn ${view === "cards" ? "primary" : ""}`}
              onClick={() => setView("cards")}
            >
              {t("regions.map.toggle_cards")}
            </button>
          </div>
        </div>
      </div>

      {showProbeHint && (
        <div className="info-banner" style={{ marginBottom: 12 }}>
          {t("regions.scan.hint")}
        </div>
      )}

      {view === "map" ? (
        <div className="panel">
          <div className="panel-head">
            <span className="title">{t("regions.map.title")}</span>
            <span className="meta">
              {rows.length} · {Object.keys(quotaByRegion).length} probed
            </span>
          </div>
          <RegionsMap
            regions={rows}
            quotaByRegion={quotaByRegion}
            selected={selected}
            onSelect={(r) => setSelected(r)}
          />
        </div>
      ) : rows.length === 0 ? (
        <div className="panel">
          <div className="empty">{t("regions.empty")}</div>
        </div>
      ) : (
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
      )}

      {selected !== null && (
        <div className="panel" style={{ marginTop: 16 }}>
          <div className="panel-head">
            <span className="title">
              {t("regions.nodes_detail", {
                region: selected === "__unknown__" ? t("regions.unknown") : selected,
              })}
            </span>
            <span className="meta">{selectedNodes.length}</span>
          </div>
          {selectedNodes.length === 0 ? (
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
          )}
        </div>
      )}
    </>
  );
}
