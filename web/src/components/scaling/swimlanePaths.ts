/**
 * Pure geometry helpers for the v3-2 Tide Chart (`SwimlaneChart.tsx`).
 *
 * Kept React-free so it can be unit tested without a DOM. Owns:
 *   - sample/event timestamp parsing
 *   - x/y scale derivation (with sane defaults for tiny windows)
 *   - SVG path string builders for active-VM area + scheduler-intent line
 *   - event-marker placement (closest-sample x, marker y)
 *
 * SRP: this module produces a `TidePlan` snapshot; the React component
 * just renders it. No state, no time-dependent calls (`Date.now()` is
 * passed in by the caller so renders are deterministic under tests).
 */
import type { MetricSample, PoolConfig, RuntimeEvent, ScaleTarget } from "../../lib/api";

/** SVG viewBox dimensions and inner chart area. */
export const TIDE_VIEW = {
  width: 760,
  height: 320,
  x0: 40,
  x1: 740,
  y0: 40,
  y1: 300,
} as const;

export const CHART_WIDTH = TIDE_VIEW.x1 - TIDE_VIEW.x0;
export const CHART_HEIGHT = TIDE_VIEW.y1 - TIDE_VIEW.y0;

export type EventGlyph =
  | "scale_up"
  | "scale_down"
  | "node_evicted"
  | "node_provisioned"
  | "node_replaced"
  | "generic";

export interface SamplePoint {
  /** Wall-clock ms since epoch. */
  ts: number;
  /** Total active VMs (ready + busy + prov + drain). */
  active: number;
  /** Scheduler-intent target, when config + backlog let us compute it. */
  target: number | null;
}

export interface EventMarker {
  ts: number;
  x: number;
  y: number;
  type: EventGlyph;
  event: RuntimeEvent;
}

export interface AxisTick {
  x: number;
  label: string;
}

export interface TidePlan {
  /** True when we had ≥ 2 samples to draw a real series. */
  drawable: boolean;
  /** True when pool config provided floor/ceiling references. */
  hasConfig: boolean;
  /** Filled area path (active VMs over time). Empty string when !drawable. */
  areaPath: string;
  /** Solid stroke path for the active area top edge. */
  topLinePath: string;
  /** Dashed scheduler-intent line. Empty string when no target series. */
  targetPath: string;
  /** Y-coordinate of `min_ready` (or null if no config). */
  floorY: number | null;
  /** Y-coordinate of `max_nodes` (or null if no config). */
  ceilingY: number | null;
  /** Floor / ceiling reference numbers passed straight through for labels. */
  floor: number | null;
  ceiling: number | null;
  /** Y-axis tick labels (VM counts) — fixed positions for readability. */
  yTicks: { y: number; label: string }[];
  /** X-axis tick labels (HH:MM). */
  xTicks: AxisTick[];
  /** Event glyph markers (already x/y-positioned). */
  events: EventMarker[];
  /** "now" cursor x + y (snapshots the last sample). */
  nowX: number;
  nowY: number;
  /** Total active at the last sample (for the right-edge dot). */
  nowActive: number;
}

const EMPTY_PLAN: TidePlan = {
  drawable: false,
  hasConfig: false,
  areaPath: "",
  topLinePath: "",
  targetPath: "",
  floorY: null,
  ceilingY: null,
  floor: null,
  ceiling: null,
  yTicks: [],
  xTicks: [],
  events: [],
  nowX: TIDE_VIEW.x1,
  nowY: TIDE_VIEW.y1,
  nowActive: 0,
};

/**
 * Total active VMs for a sample. Prefers the backend-computed `active_vms`
 * field (authoritative — see `metrics/collector.py`: `ready + running +
 * provisioning + draining`, terminating excluded). Falls back to summing
 * the per-state counts for forward-compat with older payloads. Never NaN.
 */
export function activeFor(sample: MetricSample): number {
  if (typeof sample.active_vms === "number" && Number.isFinite(sample.active_vms)) {
    return sample.active_vms;
  }
  return (
    (sample.ready_vms ?? 0) +
    (sample.running_vms ?? 0) +
    (sample.provisioning_vms ?? 0) +
    (sample.draining_vms ?? 0)
  );
}

/** clamp(ceil(backlog/concurrency), min_ready, max_nodes). null when no config. */
export function targetFor(
  sample: MetricSample,
  config: PoolConfig | undefined,
): number | null {
  if (!config) return null;
  const concurrency = Math.max(1, config.per_node_concurrency);
  const raw = Math.ceil(Math.max(0, sample.backlog ?? 0) / concurrency);
  return Math.min(config.max_nodes, Math.max(config.min_ready, raw));
}

function classifyEventType(t: string): EventGlyph {
  switch (t) {
    case "scale_up":
    case "scale_down":
    case "node_evicted":
    case "node_provisioned":
    case "node_replaced":
      return t;
    default:
      return "generic";
  }
}

function formatTickTime(ms: number): string {
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return "—";
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}

export function buildTidePlan(
  samples: MetricSample[],
  events: RuntimeEvent[],
  config: PoolConfig | undefined,
  scaleTarget: ScaleTarget | null | undefined,
): TidePlan {
  const hasConfig = config != null;
  if (samples.length < 2) {
    return { ...EMPTY_PLAN, hasConfig };
  }

  // Project each sample into (ts, active, target).
  const points: SamplePoint[] = [];
  for (const s of samples) {
    const ts = Date.parse(s.timestamp);
    if (Number.isNaN(ts)) continue;
    points.push({ ts, active: activeFor(s), target: targetFor(s, config) });
  }
  if (points.length < 2) return { ...EMPTY_PLAN, hasConfig };

  // Honour the real scheduler decision: when a live `scaleTarget` is present,
  // anchor the last point's target to `scaleTarget.target_nodes` so the dashed
  // line ends at the scheduler's actual intent (not just the per-sample
  // ceil(backlog/concurrency) derivation). This is what makes the
  // "Scheduler target" legend honest. Clamp into the config envelope so we
  // never draw outside [min_ready, max_nodes].
  if (hasConfig && scaleTarget && typeof scaleTarget.target_nodes === "number") {
    const clamped = Math.min(
      config!.max_nodes,
      Math.max(config!.min_ready, scaleTarget.target_nodes),
    );
    points[points.length - 1] = { ...points[points.length - 1], target: clamped };
  }

  const minTs = points[0].ts;
  const maxTs = points[points.length - 1].ts;
  const tsSpan = Math.max(1, maxTs - minTs); // guard div-by-zero on 1-sample windows

  // Y axis: leave headroom above ceiling and any observed peak.
  const observedMax = points.reduce((m, p) => Math.max(m, p.active), 0);
  const cfgMax = config?.max_nodes ?? 0;
  const yMaxRaw = Math.max(observedMax + 1, cfgMax + 2, 5);
  // Round up to a multiple that gives 5 clean ticks (0/25/50/75/100%).
  const yMax = Math.ceil(yMaxRaw / 4) * 4;

  const xFor = (ts: number): number =>
    TIDE_VIEW.x0 + ((ts - minTs) / tsSpan) * CHART_WIDTH;
  const yFor = (v: number): number =>
    TIDE_VIEW.y1 - (Math.max(0, Math.min(yMax, v)) / yMax) * CHART_HEIGHT;

  // Area path: walk samples, close at baseline.
  const segs: string[] = [];
  const first = points[0];
  segs.push(`M ${xFor(first.ts).toFixed(1)} ${yFor(first.active).toFixed(1)}`);
  for (let i = 1; i < points.length; i += 1) {
    const p = points[i];
    segs.push(`L ${xFor(p.ts).toFixed(1)} ${yFor(p.active).toFixed(1)}`);
  }
  const topLinePath = segs.join(" ");
  const last = points[points.length - 1];
  const areaPath =
    `${topLinePath} L ${xFor(last.ts).toFixed(1)} ${yFor(0).toFixed(1)}` +
    ` L ${xFor(first.ts).toFixed(1)} ${yFor(0).toFixed(1)} Z`;

  // Target path: only if config present (otherwise no concurrency baseline).
  let targetPath = "";
  if (hasConfig) {
    const tsegs: string[] = [];
    let started = false;
    for (const p of points) {
      if (p.target == null) continue;
      const cmd = started ? "L" : "M";
      tsegs.push(`${cmd} ${xFor(p.ts).toFixed(1)} ${yFor(p.target).toFixed(1)}`);
      started = true;
    }
    targetPath = tsegs.join(" ");
  }

  // Floor / ceiling reference lines.
  const floor = config?.min_ready ?? null;
  const ceiling = config?.max_nodes ?? null;
  const floorY = floor == null ? null : yFor(floor);
  const ceilingY = ceiling == null ? null : yFor(ceiling);

  // Axis ticks.
  const yTicks = [yMax, Math.round(yMax * 0.75), Math.round(yMax * 0.5), Math.round(yMax * 0.25), 0]
    .map((v) => ({ y: yFor(v), label: String(v) }));
  const xTicks: AxisTick[] = [0, 0.25, 0.5, 0.75].map((f) => ({
    x: TIDE_VIEW.x0 + f * CHART_WIDTH,
    label: formatTickTime(minTs + tsSpan * f),
  }));
  // Now cursor sits on the last sample.
  const nowX = xFor(last.ts);
  const nowY = yFor(last.active);

  // Event markers: snap each event to its closest sample, derive glyph from type.
  const markers: EventMarker[] = [];
  for (const ev of events) {
    const evTs = Date.parse(ev.timestamp);
    if (Number.isNaN(evTs)) continue;
    // Find closest sample index (linear; sample counts are small — bounded by API window).
    let closest = 0;
    let bestDist = Math.abs(points[0].ts - evTs);
    for (let i = 1; i < points.length; i += 1) {
      const d = Math.abs(points[i].ts - evTs);
      if (d < bestDist) {
        closest = i;
        bestDist = d;
      }
    }
    const sp = points[closest];
    markers.push({
      ts: evTs,
      x: xFor(Math.max(minTs, Math.min(maxTs, evTs))),
      y: yFor(sp.active),
      type: classifyEventType(ev.event_type),
      event: ev,
    });
  }

  return {
    drawable: true,
    hasConfig,
    areaPath,
    topLinePath,
    targetPath,
    floorY,
    ceilingY,
    floor,
    ceiling,
    yTicks,
    xTicks,
    events: markers,
    nowX,
    nowY,
    nowActive: last.active,
  };
}
