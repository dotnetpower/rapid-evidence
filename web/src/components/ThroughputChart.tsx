import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  CartesianGrid,
  Line,
  ComposedChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
  Area,
} from "recharts";
import { api, type MetricSample } from "../lib/api";
import { useI18n } from "../lib/i18n";

const WINDOWS: { label: string; seconds: number }[] = [
  { label: "15m", seconds: 15 * 60 },
  { label: "60m", seconds: 60 * 60 },
  { label: "6h", seconds: 6 * 3600 },
];

interface ChartRow {
  time: string;
  backlog: number;
  active_vms: number;
  throughput: number;
}

function shortTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleTimeString("en-US", { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function toRows(samples: MetricSample[]): ChartRow[] {
  return samples.map((s) => ({
    time: shortTime(s.timestamp),
    backlog: s.backlog,
    active_vms: s.active_vms,
    throughput: s.throughput_per_second,
  }));
}

export function ThroughputChart() {
  const [windowSeconds, setWindowSeconds] = useState(WINDOWS[1].seconds);
  const { t } = useI18n();
  const series = useQuery({
    queryKey: ["timeseries", windowSeconds],
    queryFn: () => api.metricsTimeseries(windowSeconds),
    refetchInterval: 2000,
    staleTime: 1500,
  });

  const rows = useMemo(
    () => toRows(series.data?.samples ?? []),
    [series.data]
  );

  return (
    <section className="panel">
      <div className="panel-head">
        <span className="title">{t("chart.title")}</span>
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
      <div style={{ padding: "12px 14px 6px" }}>
        <div style={{ display: "flex", gap: 14, fontSize: 11, color: "var(--text-muted)", paddingBottom: 8 }}>
          <Legend color="var(--info)">{t("chart.legend.backlog")}</Legend>
          <Legend color="var(--violet)" dashed>{t("chart.legend.vms")}</Legend>
          <Legend color="var(--ok)">{t("chart.legend.tp")}</Legend>
        </div>
        <div style={{ width: "100%", height: 260 }}>
          {rows.length < 2 ? (
            <div className="empty">
              {series.isLoading
                ? t("chart.collecting")
                : t("chart.notEnough")}
            </div>
          ) : (
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart data={rows} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
                <CartesianGrid stroke="#2b2b2b" vertical={false} />
                <XAxis dataKey="time" tick={{ fill: "#6e6e6e", fontSize: 10 }} stroke="#3c3c3c" minTickGap={28} />
                <YAxis
                  yAxisId="left"
                  tick={{ fill: "#6e6e6e", fontSize: 10 }}
                  stroke="#3c3c3c"
                  width={42}
                />
                <YAxis
                  yAxisId="right"
                  orientation="right"
                  tick={{ fill: "#6e6e6e", fontSize: 10 }}
                  stroke="#3c3c3c"
                  width={36}
                />
                <Tooltip
                  contentStyle={{
                    background: "#252526",
                    border: "1px solid #3c3c3c",
                    borderRadius: 4,
                    fontSize: 12,
                  }}
                  labelStyle={{ color: "#f3f3f3" }}
                  itemStyle={{ color: "#cccccc" }}
                />
                <Area
                  type="monotone"
                  yAxisId="left"
                  dataKey="backlog"
                  stroke="#4fc1ff"
                  fill="rgba(79,193,255,0.12)"
                  strokeWidth={1.5}
                  isAnimationActive={false}
                />
                <Line
                  type="monotone"
                  yAxisId="right"
                  dataKey="active_vms"
                  stroke="#c586c0"
                  strokeWidth={1.5}
                  strokeDasharray="3 2"
                  dot={false}
                  isAnimationActive={false}
                />
                <Line
                  type="monotone"
                  yAxisId="right"
                  dataKey="throughput"
                  stroke="#89d185"
                  strokeWidth={1.5}
                  dot={false}
                  isAnimationActive={false}
                />
              </ComposedChart>
            </ResponsiveContainer>
          )}
        </div>
      </div>
    </section>
  );
}

function Legend({ color, children, dashed = false }: { color: string; children: React.ReactNode; dashed?: boolean }) {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
      <span
        style={{
          display: "inline-block",
          width: 14,
          height: 0,
          borderTop: `2px ${dashed ? "dashed" : "solid"} ${color}`,
        }}
      />
      {children}
    </span>
  );
}
