import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";
import { useI18n } from "../lib/i18n";
import { SwimlaneChart } from "../components/scaling/SwimlaneChart";
import { EventMarkerList } from "../components/scaling/EventMarkerList";
import "../styles/scaling.css";

const WINDOWS: { label: string; seconds: number }[] = [
  { label: "15m", seconds: 15 * 60 },
  { label: "60m", seconds: 60 * 60 },
  { label: "6h", seconds: 6 * 3600 },
];

const REFETCH_INTERVAL_MS = 2000;

export function ScalingTimelinePage() {
  const { t } = useI18n();
  const [windowSeconds, setWindowSeconds] = useState(WINDOWS[1].seconds);

  const timeline = useQuery({
    queryKey: ["scaling-timeline", windowSeconds],
    queryFn: () => api.scalingTimeline(windowSeconds),
    refetchInterval: REFETCH_INTERVAL_MS,
    refetchIntervalInBackground: false,
    staleTime: REFETCH_INTERVAL_MS - 100,
  });

  const samples = timeline.data?.samples ?? [];
  const events = timeline.data?.events ?? [];

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
        </div>
      </div>

      {timeline.isError && (
        <div className="error-banner" style={{ marginBottom: 12 }}>
          {t("page.err.apiDown")}
        </div>
      )}

      <section className="panel">
        <div className="panel-head">
          <span className="title">{t("scaling.chart.title")}</span>
          <span style={{ fontSize: 11, color: "var(--text-muted)" }}>
            {t("scaling.chart.meta", {
              samples: samples.length,
              events: events.length,
            })}
          </span>
        </div>
        <div style={{ padding: "12px 14px 6px" }}>
          <SwimlaneChart samples={samples} events={events} />
        </div>
      </section>

      <section className="panel" style={{ marginTop: 12 }}>
        <div className="panel-head">
          <span className="title">{t("scaling.markers.title")}</span>
          <span style={{ fontSize: 11, color: "var(--text-muted)" }}>
            {t("scaling.markers.meta", { n: events.length })}
          </span>
        </div>
        <div style={{ padding: "8px 14px 14px" }}>
          <EventMarkerList events={events} />
        </div>
      </section>
    </>
  );
}
