import { describe, expect, it } from "vitest";
import type {
  MetricSample,
  PoolConfig,
  RuntimeEvent,
} from "../../../lib/api";
import {
  activeFor,
  buildTidePlan,
  targetFor,
  TIDE_VIEW,
} from "../swimlanePaths";

function sample(ts: string, opts: Partial<MetricSample> = {}): MetricSample {
  return {
    timestamp: ts,
    backlog: 0,
    throughput_per_second: 0,
    active_vms: 0,
    ready_vms: 0,
    running_vms: 0,
    provisioning_vms: 0,
    draining_vms: 0,
    active_batches: 0,
    ...opts,
  };
}

const CONFIG: PoolConfig = {
  min_ready: 1,
  max_nodes: 4,
  per_node_concurrency: 2,
  idle_timeout_seconds: 600,
};

describe("activeFor", () => {
  it("prefers backend-authoritative sample.active_vms when present", () => {
    // active_vms=7 differs from the per-state sum (1+2+1+1=5) on purpose:
    // we trust the backend's definition of "active" over re-summing.
    expect(
      activeFor(
        sample("2026-05-30T10:00:00Z", {
          active_vms: 7,
          ready_vms: 1,
          running_vms: 2,
          provisioning_vms: 1,
          draining_vms: 1,
        }),
      ),
    ).toBe(7);
  });

  it("falls back to per-state sum when active_vms is non-finite (forward-compat)", () => {
    // Simulate an older/partial payload by stripping active_vms with a cast.
    const partial = {
      timestamp: "2026-05-30T10:00:00Z",
      backlog: 0,
      throughput_per_second: 0,
      ready_vms: 1,
      running_vms: 2,
      provisioning_vms: 1,
      draining_vms: 1,
      active_batches: 0,
    } as unknown as MetricSample;
    expect(activeFor(partial)).toBe(5);
  });

  it("returns 0 for an entirely empty sample", () => {
    const blank = {
      timestamp: "2026-05-30T10:00:00Z",
      backlog: 0,
      throughput_per_second: 0,
      active_batches: 0,
    } as unknown as MetricSample;
    expect(activeFor(blank)).toBe(0);
  });
});

describe("targetFor", () => {
  it("returns null when config is absent", () => {
    expect(targetFor(sample("2026-05-30T10:00:00Z", { backlog: 8 }), undefined)).toBeNull();
  });

  it("clamps to min_ready when backlog is zero", () => {
    expect(targetFor(sample("2026-05-30T10:00:00Z", { backlog: 0 }), CONFIG)).toBe(1);
  });

  it("clamps to max_nodes when backlog vastly exceeds capacity", () => {
    expect(
      targetFor(sample("2026-05-30T10:00:00Z", { backlog: 9999 }), CONFIG),
    ).toBe(4);
  });

  it("uses ceil(backlog / per_node_concurrency) in the linear region", () => {
    // backlog 5, concurrency 2 -> ceil(2.5)=3 -> clamped to [1,4] -> 3
    expect(targetFor(sample("2026-05-30T10:00:00Z", { backlog: 5 }), CONFIG)).toBe(3);
  });

  it("guards per_node_concurrency=0 to avoid division by zero", () => {
    const cfg: PoolConfig = { ...CONFIG, per_node_concurrency: 0 };
    expect(
      Number.isFinite(targetFor(sample("2026-05-30T10:00:00Z", { backlog: 4 }), cfg)!),
    ).toBe(true);
  });
});

describe("buildTidePlan", () => {
  it("returns an empty plan when fewer than two samples are provided", () => {
    const plan = buildTidePlan([], [], CONFIG, null);
    expect(plan.drawable).toBe(false);
    expect(plan.areaPath).toBe("");
    expect(plan.events).toHaveLength(0);
    expect(plan.hasConfig).toBe(true);
  });

  it("reports hasConfig=false when no pool config is provided", () => {
    const plan = buildTidePlan([], [], undefined, null);
    expect(plan.hasConfig).toBe(false);
  });

  it("draws floor/ceiling reference lines inside the chart area", () => {
    const ss: MetricSample[] = [
      sample("2026-05-30T10:00:00Z", { ready_vms: 1 }),
      sample("2026-05-30T10:30:00Z", { ready_vms: 1, running_vms: 1 }),
      sample("2026-05-30T11:00:00Z", { ready_vms: 1, running_vms: 2 }),
    ];
    const plan = buildTidePlan(ss, [], CONFIG, null);
    expect(plan.drawable).toBe(true);
    expect(plan.floorY).not.toBeNull();
    expect(plan.ceilingY).not.toBeNull();
    // floor (min_ready=1) sits below ceiling (max_nodes=4): higher VM count → smaller Y.
    expect(plan.floorY!).toBeGreaterThan(plan.ceilingY!);
    // Both fall within the inner chart area.
    expect(plan.floorY!).toBeGreaterThanOrEqual(TIDE_VIEW.y0);
    expect(plan.floorY!).toBeLessThanOrEqual(TIDE_VIEW.y1);
    expect(plan.ceilingY!).toBeGreaterThanOrEqual(TIDE_VIEW.y0);
    expect(plan.ceilingY!).toBeLessThanOrEqual(TIDE_VIEW.y1);
  });

  it("places the now cursor on the right edge of the chart", () => {
    const ss: MetricSample[] = [
      sample("2026-05-30T10:00:00Z"),
      sample("2026-05-30T10:30:00Z"),
      sample("2026-05-30T11:00:00Z"),
    ];
    const plan = buildTidePlan(ss, [], CONFIG, null);
    expect(plan.nowX).toBeCloseTo(TIDE_VIEW.x1, 5);
  });

  it("snaps event markers inside the visible range and tags glyphs", () => {
    const ss: MetricSample[] = [
      sample("2026-05-30T10:00:00Z", { ready_vms: 1 }),
      sample("2026-05-30T10:30:00Z", { ready_vms: 1, running_vms: 2 }),
      sample("2026-05-30T11:00:00Z", { ready_vms: 1, running_vms: 3 }),
    ];
    const events: RuntimeEvent[] = [
      { event_type: "scale_up", timestamp: "2026-05-30T10:30:00Z", payload: { added: 2 } },
      { event_type: "node_evicted", timestamp: "2026-05-30T10:45:00Z", payload: { reason: "spot_preempted" } },
      { event_type: "unknown_event", timestamp: "2026-05-30T10:15:00Z", payload: {} },
    ];
    const plan = buildTidePlan(ss, events, CONFIG, null);
    expect(plan.events).toHaveLength(3);
    expect(plan.events[0].type).toBe("scale_up");
    expect(plan.events[1].type).toBe("node_evicted");
    expect(plan.events[2].type).toBe("generic");
    for (const ev of plan.events) {
      expect(ev.x).toBeGreaterThanOrEqual(TIDE_VIEW.x0);
      expect(ev.x).toBeLessThanOrEqual(TIDE_VIEW.x1);
    }
  });

  it("emits 4 x-axis ticks and 5 y-axis ticks", () => {
    const ss: MetricSample[] = [
      sample("2026-05-30T10:00:00Z"),
      sample("2026-05-30T11:00:00Z"),
    ];
    const plan = buildTidePlan(ss, [], CONFIG, null);
    expect(plan.xTicks).toHaveLength(4);
    expect(plan.yTicks).toHaveLength(5);
  });

  it("omits the target path when no pool config is supplied", () => {
    const ss: MetricSample[] = [
      sample("2026-05-30T10:00:00Z"),
      sample("2026-05-30T11:00:00Z"),
    ];
    const plan = buildTidePlan(ss, [], undefined, null);
    expect(plan.targetPath).toBe("");
  });

  it("anchors the dashed target line to the live scaleTarget on the last sample", () => {
    // Sample backlog would compute target=1 (clamped to min_ready), but the
    // live scheduler decision says target=3. The dashed line must end at the
    // scheduler-intent y-coordinate, not the per-sample backlog derivation.
    const ss: MetricSample[] = [
      sample("2026-05-30T10:00:00Z", { backlog: 0, ready_vms: 1 }),
      sample("2026-05-30T10:30:00Z", { backlog: 0, ready_vms: 1 }),
    ];
    const planWithoutTarget = buildTidePlan(ss, [], CONFIG, null);
    const planWithTarget = buildTidePlan(ss, [], CONFIG, {
      target_nodes: 3,
      scale_up_nodes: 2,
      scale_down_nodes: 0,
      immediate_tasks: 0,
      queued_tasks: 0,
      overflow_tasks: 0,
    });
    // Both paths are non-empty (config is present), but the live-target path
    // ends with a different y-coordinate than the backlog-derived one.
    expect(planWithoutTarget.targetPath).not.toBe("");
    expect(planWithTarget.targetPath).not.toBe("");
    expect(planWithTarget.targetPath).not.toBe(planWithoutTarget.targetPath);
  });

  it("clamps an out-of-range scaleTarget into [min_ready, max_nodes]", () => {
    const ss: MetricSample[] = [
      sample("2026-05-30T10:00:00Z", { backlog: 0 }),
      sample("2026-05-30T10:30:00Z", { backlog: 0 }),
    ];
    // target_nodes=999 must clamp to max_nodes=4; otherwise the dashed line
    // would draw outside the chart area or above the ceiling band.
    const plan = buildTidePlan(ss, [], CONFIG, {
      target_nodes: 999,
      scale_up_nodes: 0,
      scale_down_nodes: 0,
      immediate_tasks: 0,
      queued_tasks: 0,
      overflow_tasks: 0,
    });
    expect(plan.targetPath).not.toBe("");
    // Last coordinate of the target path stays within the chart's vertical
    // bounds [y0, y1].
    const lastY = Number(plan.targetPath.trim().split(" ").slice(-1)[0]);
    expect(lastY).toBeGreaterThanOrEqual(TIDE_VIEW.y0);
    expect(lastY).toBeLessThanOrEqual(TIDE_VIEW.y1);
  });
});
