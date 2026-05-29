import { useMemo } from "react";
import {
  Area,
  CartesianGrid,
  ComposedChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { MetricSample, RuntimeEvent } from "../../lib/api";
import { useI18n } from "../../lib/i18n";

interface Props {
  samples: MetricSample[];
  events: RuntimeEvent[];
}

interface Row {
  time: string;
  timestamp: number;
  ready: number;
  busy: number;
  prov: number;
  draining: number;
  marker?: number;
}

function shortTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleTimeString("en-US", {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function buildRows(samples: MetricSample[], events: RuntimeEvent[]): Row[] {
  const rows: Row[] = samples.map((s) => ({
    time: shortTime(s.timestamp),
    timestamp: Date.parse(s.timestamp),
    ready: s.ready_vms ?? 0,
    busy: s.running_vms ?? 0,
    prov: s.provisioning_vms ?? 0,
    draining: s.draining_vms ?? 0,
  }));
  if (rows.length === 0 || events.length === 0) return rows;
  // Attach marker height (= total active VMs) on the closest sample row
  // so the chart can render a vertical bar at the event's x position.
  for (const ev of events) {
    const evTs = Date.parse(ev.timestamp);
    if (Number.isNaN(evTs)) continue;
    let closestIdx = 0;
    let closestDist = Math.abs(rows[0].timestamp - evTs);
    for (let i = 1; i < rows.length; i += 1) {
      const dist = Math.abs(rows[i].timestamp - evTs);
      if (dist < closestDist) {
        closestIdx = i;
        closestDist = dist;
      }
    }
    const target = rows[closestIdx];
    const stackTotal =
      target.ready + target.busy + target.prov + target.draining;
    target.marker = Math.max(stackTotal, 1);
  }
  return rows;
}

export function SwimlaneChart({ samples, events }: Props) {
  const { t } = useI18n();
  const rows = useMemo(() => buildRows(samples, events), [samples, events]);

  if (rows.length < 2) {
    return (
      <div className="swimlane swimlane--empty">
        {t("scaling.empty")}
      </div>
    );
  }

  return (
    <div className="swimlane">
      <div className="swimlane__legend">
        <LegendDot color="var(--ok)">{t("scaling.legend.ready")}</LegendDot>
        <LegendDot color="var(--info)">{t("scaling.legend.busy")}</LegendDot>
        <LegendDot color="var(--warn)">{t("scaling.legend.prov")}</LegendDot>
        <LegendDot color="var(--violet)">{t("scaling.legend.draining")}</LegendDot>
        <LegendDot color="var(--bad)" dashed>{t("scaling.legend.event")}</LegendDot>
      </div>
      <div style={{ width: "100%", height: 280 }}>
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={rows} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
            <CartesianGrid stroke="#2b2b2b" vertical={false} />
            <XAxis
              dataKey="time"
              tick={{ fill: "#6e6e6e", fontSize: 10 }}
              stroke="#3c3c3c"
              minTickGap={28}
            />
            <YAxis
              tick={{ fill: "#6e6e6e", fontSize: 10 }}
              stroke="#3c3c3c"
              width={42}
              allowDecimals={false}
              label={{
                value: "VMs",
                angle: -90,
                position: "insideLeft",
                offset: 12,
                style: { fill: "#6e6e6e", fontSize: 10 },
              }}
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
              stackId="vms"
              dataKey="ready"
              stroke="#89d185"
              fill="rgba(137,209,133,0.30)"
              isAnimationActive={false}
            />
            <Area
              type="monotone"
              stackId="vms"
              dataKey="busy"
              stroke="#4fc1ff"
              fill="rgba(79,193,255,0.30)"
              isAnimationActive={false}
            />
            <Area
              type="monotone"
              stackId="vms"
              dataKey="prov"
              stroke="#cca700"
              fill="rgba(204,167,0,0.30)"
              isAnimationActive={false}
            />
            <Area
              type="monotone"
              stackId="vms"
              dataKey="draining"
              stroke="#c586c0"
              fill="rgba(197,134,192,0.30)"
              isAnimationActive={false}
            />
            <Area
              type="step"
              dataKey="marker"
              stroke="#f48771"
              strokeWidth={1.2}
              strokeDasharray="2 2"
              fill="transparent"
              isAnimationActive={false}
            />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

function LegendDot({
  color,
  children,
  dashed = false,
}: {
  color: string;
  children: React.ReactNode;
  dashed?: boolean;
}) {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 11 }}>
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
