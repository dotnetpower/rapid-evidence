import type { DashboardSummary } from "../lib/api";

interface PoolPanelProps {
  data: DashboardSummary | undefined;
}

function ratio(part: number | undefined, target: number | undefined): string {
  if (target == null || target === 0) return "0%";
  const pct = Math.min(100, Math.max(0, (Number(part ?? 0) / target) * 100));
  return `${pct}%`;
}

export function PoolPanel({ data }: PoolPanelProps) {
  const counters = data?.pool?.counters ?? {};
  const config = data?.pool?.config;
  const scale = data?.scale_target;

  const target = scale?.target_nodes ?? config?.max_nodes ?? 0;
  const ready = Number(counters.ready ?? 0);
  const running = Number(counters.busy ?? 0);
  const provisioning = Number(counters.provisioning ?? 0);
  const draining =
    Number(counters.draining ?? 0) + Number(counters.terminating ?? 0);
  const active = ready + running + provisioning + draining;

  return (
    <section className="panel scaling">
      <div className="panel-head">
        <span className="title">풀 확장 진행</span>
        <span className="meta">
          target {target} · current {active}
          {config && ` · max ${config.max_nodes}`}
        </span>
      </div>
      <div className="row">
        <span className="lbl">ready</span>
        <div className="meter ok">
          <span style={{ width: ratio(ready, target) }} />
        </div>
        <span className="val">{ready} / {target || "—"}</span>
      </div>
      <div className="row">
        <span className="lbl">running</span>
        <div className="meter violet">
          <span style={{ width: ratio(running, target) }} />
        </div>
        <span className="val">{running} / {target || "—"}</span>
      </div>
      <div className="row">
        <span className="lbl">provisioning</span>
        <div className="meter">
          <span style={{ width: ratio(provisioning, target) }} />
        </div>
        <span className="val">{provisioning} / {target || "—"}</span>
      </div>
      <div className="row">
        <span className="lbl">draining</span>
        <div className="meter warn">
          <span style={{ width: ratio(draining, target) }} />
        </div>
        <span className="val">{draining} / {target || "—"}</span>
      </div>
      <div
        className="row"
        style={{ borderTop: "1px solid var(--border-strong)", marginTop: 4 }}
      >
        <span className="lbl">scale progress</span>
        <div className="meter ok">
          <span style={{ width: ratio(active, target) }} />
        </div>
        <span className="val">{active} / {target || "—"}</span>
      </div>
      <div className="row full">
        <span className="lbl">scale-up nodes</span>
        <span className="val">{scale?.scale_up_nodes ?? 0}</span>
      </div>
      <div className="row full">
        <span className="lbl">overflow tasks</span>
        <span className="val">{scale?.overflow_tasks ?? 0}</span>
      </div>
      <div className="row full">
        <span className="lbl">evictions (total)</span>
        <span className="val">
          {Number(data?.pool?.metrics?.evictions_total ?? 0)}
          {" · replaced "}
          {Number(data?.pool?.metrics?.nodes_replaced_total ?? 0)}
        </span>
      </div>
    </section>
  );
}
