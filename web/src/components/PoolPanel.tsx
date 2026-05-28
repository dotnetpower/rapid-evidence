import type { DashboardSummary } from "../lib/api";
import { useI18n } from "../lib/i18n";

interface PoolPanelProps {
  data: DashboardSummary | undefined;
}

function ratio(part: number | undefined, target: number | undefined): string {
  if (target == null || target === 0) return "0%";
  const pct = Math.min(100, Math.max(0, (Number(part ?? 0) / target) * 100));
  return `${pct}%`;
}

export function PoolPanel({ data }: PoolPanelProps) {
  const { t } = useI18n();
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
        <span className="title">{t("pool.title")}</span>
        <span className="meta">
          {t("pool.meta", { target, active })}
          {config && t("pool.metaMax", { max: config.max_nodes })}
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
        <span className="lbl">{t("pool.scaleProgress")}</span>
        <div className="meter ok">
          <span style={{ width: ratio(active, target) }} />
        </div>
        <span className="val">{active} / {target || "—"}</span>
      </div>
      <div className="row full">
        <span className="lbl">{t("pool.scaleUpNodes")}</span>
        <span className="val">{scale?.scale_up_nodes ?? 0}</span>
      </div>
      <div className="row full">
        <span className="lbl">{t("pool.overflowTasks")}</span>
        <span className="val">{scale?.overflow_tasks ?? 0}</span>
      </div>
      <div className="row full">
        <span className="lbl">{t("pool.evictionsTotal")}</span>
        <span className="val">
          {Number(data?.pool?.metrics?.evictions_total ?? 0)}
          {" · "}{t("pool.replaced")}{" "}
          {Number(data?.pool?.metrics?.nodes_replaced_total ?? 0)}
        </span>
      </div>
      <NodesList nodes={data?.pool?.nodes ?? []} />
      <EvictionsList events={data?.pool?.recent_evictions ?? []} />
    </section>
  );
}

interface NodesListProps {
  nodes: NonNullable<DashboardSummary["pool"]["nodes"]>;
}

function NodesList({ nodes }: NodesListProps) {
  const { t } = useI18n();
  if (!nodes || nodes.length === 0) {
    return (
      <div className="row full" style={{ opacity: 0.6 }}>
        <span className="lbl">{t("pool.nodesNone")}</span>
        <span className="val">—</span>
      </div>
    );
  }
  return (
    <div style={{ marginTop: 12 }}>
      <div className="lbl" style={{ marginBottom: 4 }}>
        {t("pool.nodesList", { n: nodes.length })}
      </div>
      <table
        style={{
          width: "100%",
          fontSize: 11,
          borderCollapse: "collapse",
        }}
      >
        <thead>
          <tr style={{ opacity: 0.7, textAlign: "left" }}>
            <th style={{ padding: "2px 4px" }}>{t("pool.col.id")}</th>
            <th style={{ padding: "2px 4px" }}>{t("pool.col.state")}</th>
            <th style={{ padding: "2px 4px", textAlign: "right" }}>{t("pool.col.inflight")}</th>
            <th style={{ padding: "2px 4px" }}>{t("pool.col.outbound")}</th>
          </tr>
        </thead>
        <tbody>
          {nodes.map((n) => (
            <tr key={n.node_id} title={n.name}>
              <td
                style={{
                  padding: "2px 4px",
                  fontFamily: "monospace",
                  maxWidth: 100,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {n.node_id}
              </td>
              <td style={{ padding: "2px 4px" }}>
                <span className={`pill state-${n.state}`}>{n.state}</span>
              </td>
              <td style={{ padding: "2px 4px", textAlign: "right" }}>
                {n.inflight}
              </td>
              <td
                style={{
                  padding: "2px 4px",
                  fontFamily: "monospace",
                  opacity: n.outbound_ip ? 1 : 0.4,
                }}
              >
                {n.outbound_ip ?? "—"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

interface EvictionsListProps {
  events: NonNullable<DashboardSummary["pool"]["recent_evictions"]>;
}

function EvictionsList({ events }: EvictionsListProps) {
  const { t } = useI18n();
  if (!events || events.length === 0) return null;
  return (
    <div style={{ marginTop: 12 }}>
      <div className="lbl" style={{ marginBottom: 4 }}>
        {t("pool.recentEvictions", { n: events.length })}
      </div>
      <ul style={{ fontSize: 11, margin: 0, paddingLeft: 16 }}>
        {events.slice(-6).reverse().map((e, idx) => (
          <li key={`${e.node_id}-${idx}`} style={{ marginBottom: 2 }}>
            <span style={{ fontFamily: "monospace" }}>{e.node_id}</span>{" "}
            <span style={{ opacity: 0.7 }}>({e.reason})</span>
            {e.requeue_task_ids.length > 0 && (
              <span style={{ opacity: 0.7 }}>
                {" · "}{t("pool.requeued")} {e.requeue_task_ids.length}
              </span>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
