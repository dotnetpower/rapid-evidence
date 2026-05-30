import { useMemo, useState } from "react";
import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { useOutletContext } from "react-router-dom";
import { api, type DashboardSummary } from "../lib/api";
import { useI18n } from "../lib/i18n";
import { formatNumber, timeAgo } from "../lib/format";
import { useNowTick } from "../lib/useNowTick";
import { useDocumentTitle } from "../lib/useDocumentTitle";
import { useFavorites } from "../lib/useFavorites";
import { useToast } from "../lib/useToast";
import { downloadCsv, csvDateStamp } from "../lib/csv";
import { RegionCard } from "../components/regions/RegionCard";
import { RegionsMap } from "../components/regions/RegionsMap";
import { RegionQuotaTable } from "../components/regions/RegionQuotaTable";
import { RegionsToolbar } from "../components/regions/RegionsToolbar";
import { RegionDetailPanel } from "../components/regions/RegionDetailPanel";
import {
  filterProbes,
  filterRegions,
  sortProbes,
  type RegionSortKey,
} from "../components/regions/regionFilter";
import { extractProbeBundle } from "../components/regions/probeBundle";
import "../styles/quota-regions.css";

type ViewMode = "map" | "cards";

export function RegionsPage() {
  const { t } = useI18n();
  const toast = useToast();
  const [selected, setSelected] = useState<string | null>(null);
  const [view, setView] = useState<ViewMode>("map");
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<RegionSortKey>("observed-first");
  const favorites = useFavorites("rapid-evidence:fav-regions", {
    onCapExceeded: (cap) => toast(t("toast.favoritesCap", { cap }), "info"),
  });
  const now = useNowTick(1000);

  const regions = useQuery({
    queryKey: ["regions-status"],
    queryFn: () => api.regionsStatus(),
    refetchInterval: 5000,
    staleTime: 3000,
  });
  // Share the shell-level dashboard-summary query \u2014 the previous local
  // observer had no `tabVisible` gate, so it kept polling on a background
  // tab even though the shell's own observer was paused.
  const summary = useOutletContext<UseQueryResult<DashboardSummary>>();
  const jobs = useQuery({
    queryKey: ["jobs", "regions-page"],
    queryFn: () => api.jobsList(50),
    refetchInterval: 10000,
    staleTime: 5000,
  });

  const allRows = regions.data?.regions ?? [];
  const nodes = (summary.data as DashboardSummary | undefined)?.pool?.nodes ?? [];
  const probeBundle = useMemo(
    () => extractProbeBundle(jobs.data?.jobs ?? []),
    [jobs.data],
  );

  // Apply search to BOTH the card/map list and the probe table
  // so the user has one mental model of "what am I looking at".
  const rows = useMemo(() => filterRegions(allRows, query), [allRows, query]);
  const filteredProbes = useMemo(
    () => filterProbes(probeBundle.probes, query),
    [probeBundle.probes, query],
  );
  const sortedProbes = useMemo(
    () => sortProbes(filteredProbes, sort, favorites.set),
    [filteredProbes, sort, favorites.set],
  );

  // Tab title shows the count of regions currently in trouble (zero headroom).
  const lowCount = useMemo(
    () => probeBundle.probes.filter((p) => p.observed && (p.headroom ?? 1) <= 0).length,
    [probeBundle.probes],
  );
  useDocumentTitle(t("regions.page.title"), lowCount > 0 ? lowCount : null);

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

  function exportCsv() {
    if (sortedProbes.length === 0) {
      toast(t("toast.csvEmpty"), "info");
      return;
    }
    const headers = ["region", "used", "limit", "headroom", "observed", "favorite", "error"];
    const data = sortedProbes.map((p) => [
      p.region,
      p.used ?? "",
      p.limit ?? "",
      p.headroom ?? "",
      p.observed ? "yes" : "no",
      favorites.has(p.region) ? "yes" : "no",
      p.error ?? "",
    ]);
    downloadCsv(`regions-${csvDateStamp()}.csv`, headers, data);
    toast(t("toast.csvExported", { n: data.length }), "success");
  }

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
          <div className="region-legend" aria-label={t("regions.legend.title")}>
            <span><span className="swatch healthy" />{t("regions.legend.healthy")}</span>
            <span><span className="swatch busy" />{t("regions.legend.busy")}</span>
            <span><span className="swatch evicting" />{t("regions.legend.evicting")}</span>
            <span><span className="swatch unknown" />{t("regions.legend.unknown")}</span>
          </div>
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
        <RegionsToolbar
          query={query}
          onQuery={setQuery}
          sort={sort}
          onSort={setSort}
          onExport={exportCsv}
          exportDisabled={sortedProbes.length === 0}
          matchCount={filteredProbes.length}
          totalCount={probeBundle.probes.length}
        />
        <RegionQuotaTable
          probes={sortedProbes}
          selected={selected}
          onSelect={setSelected}
          lastScanAt={probeBundle.lastScanAt}
          nowMs={now}
          favorites={favorites.set}
          onToggleFavorite={favorites.toggle}
        />
      </section>

      {selected !== null && (
        <RegionDetailPanel
          selected={selected}
          nodes={selectedNodes}
          probe={selectedProbe}
        />
      )}
    </>
  );
}
