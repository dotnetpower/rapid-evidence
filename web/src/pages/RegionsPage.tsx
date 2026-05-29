import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, type DashboardSummary } from "../lib/api";
import { useI18n } from "../lib/i18n";
import { formatNumber, timeAgo } from "../lib/format";
import { useNowTick } from "../lib/useNowTick";
import { RegionCard } from "../components/regions/RegionCard";
import { RegionsMap } from "../components/regions/RegionsMap";
import { RegionQuotaTable } from "../components/regions/RegionQuotaTable";
import { extractProbeBundle } from "../components/regions/probeBundle";
import "../styles/quota-regions.css";

type ViewMode = "map" | "cards";

export function RegionsPage() {
  const { t } = useI18n();
  const [selected, setSelected] = useState<string | null>(null);
  const [view, setView] = useState<ViewMode>("map");
  const now = useNowTick(1000);

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
  const probeBundle = useMemo(
    () => extractProbeBundle(jobs.data?.jobs ?? []),
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

  const selectedProbe =
    selected && selected !== "__unknown__"
      ? probeBundle.byRegion[selected] ?? null
      : null;

  const showProbeHint =
    view === "map" && probeBundle.totalCount === 0;

  const hasScan = probeBundle.totalCount > 0;

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

      <section className="panel quota-totals" style={{ marginBottom: 12 }}>
        <div className="panel-head">
          <span className="title">{t("regions.totals.title")}</span>
          <span className="meta">
            {hasScan
              ? t("regions.totals.lastScan", { ago: timeAgo(probeBundle.lastScanAt, now) })
              : t("regions.totals.noScan")}
          </span>
        </div>
        <div className="quota-totals__grid">
          <div className="quota-totals__cell">
            <div className="lbl">{t("regions.totals.limit")}</div>
            <div className="val">{formatNumber(probeBundle.totalLimit)}</div>
          </div>
          <div className="quota-totals__cell">
            <div className="lbl">{t("regions.totals.used")}</div>
            <div className="val">{formatNumber(probeBundle.totalUsed)}</div>
          </div>
          <div className="quota-totals__cell ok">
            <div className="lbl">{t("regions.totals.headroom")}</div>
            <div className="val">{formatNumber(probeBundle.totalHeadroom)}</div>
          </div>
          <div className="quota-totals__cell">
            <div className="lbl">{t("regions.totals.observed")}</div>
            <div className="val">
              {probeBundle.observedCount} / {probeBundle.totalCount}
            </div>
          </div>
        </div>
      </section>

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
              {t("regions.map.regionsMeta", {
                live: rows.length,
                probed: probeBundle.totalCount,
              })}
            </span>
          </div>
          <RegionsMap
            regions={rows}
            quotaByRegion={probeBundle.byRegion}
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

      <section className="panel" style={{ marginTop: 16 }}>
        <div className="panel-head">
          <span className="title">{t("regions.quotaTable.title")}</span>
          <span className="meta">
            {probeBundle.totalCount}
          </span>
        </div>
        <RegionQuotaTable
          probes={probeBundle.probes}
          selected={selected}
          onSelect={setSelected}
        />
      </section>

      {selected !== null && (
        <div className="panel" style={{ marginTop: 16 }}>
          <div className="panel-head">
            <span className="title">
              {t("regions.nodes_detail", {
                region: selected === "__unknown__" ? t("regions.unknown") : selected,
              })}
            </span>
            <span className="meta">
              {selectedProbe?.observed
                ? `${selectedProbe.used ?? "—"}/${selectedProbe.limit ?? "—"} · headroom ${selectedProbe.headroom ?? "—"}`
                : `${selectedNodes.length}`}
            </span>
          </div>
          {selectedProbe?.error && (
            <div className="info-banner" style={{ margin: 12, color: "var(--bad, #e06c75)" }}>
              {selectedProbe.error}
            </div>
          )}
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
