import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useOutletContext, useSearchParams } from "react-router-dom";
import type { UseQueryResult } from "@tanstack/react-query";
import { api, type DashboardSummary, type RuntimeEvent } from "../lib/api";
import { useI18n } from "../lib/i18n";
import { useDocumentTitle } from "../lib/useDocumentTitle";
import { usePageVisibility } from "../lib/usePageVisibility";
import { useToast } from "../lib/useToast";
import { downloadCsv, csvDateStamp } from "../lib/csv";
import { SwimlaneChart } from "../components/scaling/SwimlaneChart";
import { EventMarkerList } from "../components/scaling/EventMarkerList";
import { SnapshotRibbons } from "../components/scaling/SnapshotRibbons";
import "../styles/scaling.css";

const WINDOWS: { label: string; seconds: number }[] = [
  { label: "15m", seconds: 15 * 60 },
  { label: "60m", seconds: 60 * 60 },
  { label: "6h", seconds: 6 * 3600 },
];

const REFETCH_INTERVAL_MS = 2000;
const ALLOWED_WINDOW_SECONDS = new Set(WINDOWS.map((w) => w.seconds));

function parseWindowSeconds(raw: string | null): number {
  if (!raw) return WINDOWS[1].seconds;
  const n = Number.parseInt(raw, 10);
  if (Number.isFinite(n) && ALLOWED_WINDOW_SECONDS.has(n)) return n;
  return WINDOWS[1].seconds;
}

export function ScalingTimelinePage() {
  const { t } = useI18n();
  const toast = useToast();
  const tabVisible = usePageVisibility();
  const [searchParams, setSearchParams] = useSearchParams();

  // URL-persisted window so deep-links share scope; falls back to 60m.
  const windowSeconds = parseWindowSeconds(searchParams.get("window"));
  function setWindowSeconds(next: number) {
    const params = new URLSearchParams(searchParams);
    if (next === WINDOWS[1].seconds) params.delete("window");
    else params.set("window", String(next));
    setSearchParams(params, { replace: true });
  }

  // Discoverable event-type filter chips. Empty Set = "all".
  const [selectedTypes, setSelectedTypes] = useState<ReadonlySet<string>>(new Set());

  // Reuse the shell-level dashboard-summary query (same cache key) so we
  // don't double-poll `/dashboard/summary` from this page.
  const summary = useOutletContext<UseQueryResult<DashboardSummary>>();

  const timeline = useQuery({
    queryKey: ["scaling-timeline", windowSeconds],
    queryFn: () => api.scalingTimeline(windowSeconds),
    refetchInterval: tabVisible ? REFETCH_INTERVAL_MS : false,
    refetchIntervalInBackground: false,
    staleTime: REFETCH_INTERVAL_MS - 100,
  });

  const samples = timeline.data?.samples ?? [];
  const allEvents = timeline.data?.events ?? [];
  const pool = summary.data?.pool;
  const config = pool?.config;
  const scaleTarget = summary.data?.scale_target ?? null;
  const windowLabel =
    WINDOWS.find((w) => w.seconds === windowSeconds)?.label ?? `${windowSeconds}s`;

  // Build a stable, alphabetised list of known event types for the chips.
  // Bounded by number of distinct event_types in the current window.
  const eventTypes = useMemo(() => {
    const counts = new Map<string, number>();
    for (const e of allEvents) counts.set(e.event_type, (counts.get(e.event_type) ?? 0) + 1);
    return Array.from(counts.entries())
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([type, n]) => ({ type, n }));
  }, [allEvents]);

  // Prune selected types that no longer exist in the window so the
  // filter chip count doesn't go stale.
  useEffect(() => {
    if (selectedTypes.size === 0) return;
    const known = new Set(eventTypes.map((e) => e.type));
    let changed = false;
    const next = new Set<string>();
    for (const t of selectedTypes) {
      if (known.has(t)) next.add(t);
      else changed = true;
    }
    if (changed) setSelectedTypes(next);
  }, [eventTypes, selectedTypes]);

  const events: RuntimeEvent[] = useMemo(() => {
    if (selectedTypes.size === 0) return allEvents;
    return allEvents.filter((e) => selectedTypes.has(e.event_type));
  }, [allEvents, selectedTypes]);

  function toggleType(type: string) {
    setSelectedTypes((prev) => {
      const next = new Set(prev);
      if (next.has(type)) next.delete(type);
      else next.add(type);
      return next;
    });
  }
  function clearTypes() {
    setSelectedTypes(new Set());
  }

  // Tab title shows the count of events currently in the window.
  useDocumentTitle(
    t("scaling.page.title"),
    events.length > 0 ? events.length : null,
  );

  function exportCsv() {
    if (events.length === 0) {
      toast(t("toast.csvEmpty"), "info");
      return;
    }
    const headers = ["timestamp", "event_type", "payload_json"];
    const data = events.map((e) => [
      e.timestamp,
      e.event_type,
      JSON.stringify(e.payload),
    ]);
    downloadCsv(`scaling-events-${csvDateStamp()}.csv`, headers, data);
    toast(t("toast.csvExported", { n: data.length }), "success");
  }

  return (
    <>
      <div className="page-head">
        <div>
          <h1>{t("scaling.page.title")}</h1>
          <div className="sub">{t("scaling.page.sub")}</div>
        </div>
        <div className="actions">
          <div className="toggle">
            {WINDOWS.map((w) => (
              <button
                key={w.seconds}
                className={w.seconds === windowSeconds ? "on" : ""}
                onClick={() => setWindowSeconds(w.seconds)}
              >
                {w.label}
              </button>
            ))}
          </div>
          <button
            type="button"
            className="btn"
            onClick={exportCsv}
            disabled={events.length === 0}
            title={t("common.exportCsv")}
          >
            ⇩ CSV
          </button>
        </div>
      </div>

      {timeline.isError && (
        <div className="error-banner" style={{ marginBottom: 12 }}>
          {t("page.err.apiDown")}
        </div>
      )}

      {eventTypes.length > 0 && (
        <div
          className="panel"
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            flexWrap: "wrap",
            padding: "8px 12px",
            marginBottom: 12,
          }}
        >
          <span style={{ fontSize: 11, color: "var(--text-muted)", marginRight: 4 }}>
            {t("scaling.event.filter")}
          </span>
          {eventTypes.map(({ type, n }) => {
            const on = selectedTypes.has(type);
            return (
              <button
                key={type}
                type="button"
                className={`btn${on ? " primary" : ""}`}
                style={{ padding: "2px 8px", fontSize: 11 }}
                onClick={() => toggleType(type)}
                aria-pressed={on}
                title={t("scaling.event.filter.toggle", { type })}
              >
                {type}{" "}
                <span style={{ opacity: 0.65, fontVariantNumeric: "tabular-nums" }}>· {n}</span>
              </button>
            );
          })}
          {selectedTypes.size > 0 && (
            <button
              type="button"
              className="btn"
              style={{ padding: "2px 8px", fontSize: 11 }}
              onClick={clearTypes}
            >
              {t("common.clear")}
            </button>
          )}
        </div>
      )}

      <section className="panel">
        <div className="panel-head">
          <span className="title">
            {t("scaling.chart.title", { window: windowLabel })}
          </span>
          <span style={{ fontSize: 11, color: "var(--text-muted)" }}>
            {t("scaling.chart.meta", {
              samples: samples.length,
              events: events.length,
            })}
          </span>
        </div>
        <SwimlaneChart
          samples={samples}
          events={events}
          config={config}
          scaleTarget={scaleTarget}
        />
      </section>

      <div className="scaling-grid">
        <section className="panel">
          <div className="panel-head">
            <span className="title">{t("scaling.snapshot.title")}</span>
            <span
              style={{ fontSize: 11, color: "var(--text-muted)", fontFamily: "var(--mono)" }}
            >
              {t("scaling.snapshot.meta")}
            </span>
          </div>
          <SnapshotRibbons pool={pool} scaleTarget={scaleTarget} />
        </section>

        <section className="panel">
          <div className="panel-head">
            <span className="title">{t("scaling.markers.title")}</span>
            <span style={{ fontSize: 11, color: "var(--text-muted)" }}>
              {t("scaling.markers.meta", { n: events.length })}
            </span>
          </div>
          <EventMarkerList events={events} />
        </section>
      </div>
    </>
  );
}


