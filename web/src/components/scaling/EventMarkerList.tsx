/**
 * EventMarkerList — v3-2 "Decision tape".
 *
 * Newest-first scale-event log, paired with the tide chart. Each row shows:
 *   • absolute HH:MM:SS timestamp (mono, left)
 *   • coloured pill keyed off `event_type`
 *   • a translated "what" headline derived from event_type + payload
 *   • a "why" sentence that surfaces the scheduler reason code as a
 *     `<code>` token (spot_preempted, idle_timeout, ceiling_clamp, …)
 *
 * Payload formatting is bounded to first-class fields so an arbitrarily
 * deep payload can never make the tape grow without bound.
 */
import type { ReactNode } from "react";
import type { RuntimeEvent } from "../../lib/api";
import { useI18n } from "../../lib/i18n";

interface Props {
  events: RuntimeEvent[];
}

export function EventMarkerList({ events }: Props) {
  const { t } = useI18n();
  if (!events || events.length === 0) {
    return <div className="tape tape--empty">{t("scaling.markers.empty")}</div>;
  }
  const sorted = [...events].sort((a, b) =>
    a.timestamp < b.timestamp ? 1 : a.timestamp > b.timestamp ? -1 : 0,
  );
  return (
    <ul className="tape">
      {sorted.map((event, idx) => (
        <TapeRow key={`${event.timestamp}|${event.event_type}|${idx}`} event={event} />
      ))}
    </ul>
  );
}

function TapeRow({ event }: { event: RuntimeEvent }) {
  const { t } = useI18n();
  const pillCls = pillClassFor(event.event_type);
  return (
    <li className="tape-item">
      <span className="tape-item__ts" title={event.timestamp}>{formatClock(event.timestamp)}</span>
      <span className={`tape-item__pill ${pillCls}`} aria-hidden="true" />
      <div>
        <div className="tape-item__what">{renderWhat(event, t)}</div>
        <div className="tape-item__why">{renderWhy(event, t)}</div>
      </div>
    </li>
  );
}

function pillClassFor(eventType: string): string {
  switch (eventType) {
    case "scale_up":
    case "scale_down":
    case "node_evicted":
    case "node_provisioned":
    case "node_replaced":
      return `tape-item__pill--${eventType}`;
    default:
      return "tape-item__pill--generic";
  }
}

function formatClock(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

type TFn = (key: string, vars?: Record<string, string | number>) => string;

function renderWhat(event: RuntimeEvent, t: TFn): string {
  const p = event.payload ?? {};
  switch (event.event_type) {
    case "scale_up": {
      const n = numberFrom(p, ["added", "delta", "count"], 1);
      return t("scaling.event.scale_up", { n });
    }
    case "scale_down": {
      const n = numberFrom(p, ["removed", "delta", "count"], 1);
      return t("scaling.event.scale_down", { n });
    }
    case "node_evicted":
      return t("scaling.event.node_evicted", { id: shortNodeId(p) });
    case "node_provisioned":
      return t("scaling.event.node_provisioned", { id: shortNodeId(p) });
    case "node_replaced":
      return t("scaling.event.node_replaced", { id: shortNodeId(p) });
    default:
      return t("scaling.event.generic", { type: event.event_type });
  }
}

function renderWhy(event: RuntimeEvent, t: TFn): ReactNode {
  const p = event.payload ?? {};
  switch (event.event_type) {
    case "scale_up": {
      const tasks = numberFrom(p, ["tasks", "backlog", "requested_tasks"], 0);
      const concurrency = numberFrom(p, ["concurrency", "per_node_concurrency"], 1);
      const target = numberFrom(p, ["target", "target_nodes"], 0);
      return renderReasonTemplate(
        t("scaling.reason.demand", { tasks, concurrency, target }),
      );
    }
    case "scale_down": {
      const idle = numberFrom(p, ["idle_seconds", "idle"], 0);
      const limit = numberFrom(p, ["idle_timeout_seconds", "idle_timeout"], 0);
      const target = numberFrom(p, ["target", "target_nodes"], 0);
      const active = numberFrom(p, ["active", "active_vms"], 0);
      if (idle > 0 && limit > 0) {
        return renderReasonTemplate(
          t("scaling.reason.idle_timeout", { seconds: idle, limit }),
        );
      }
      if (target > 0 && active > 0) {
        return renderReasonTemplate(
          t("scaling.reason.target_drop", { target, active }),
        );
      }
      return summarisePayload(p, t);
    }
    case "node_evicted": {
      const reason = stringFrom(p, ["reason"], "");
      const requeued = numberFrom(p, ["requeued", "requeue_count"], 0);
      if (reason === "spot_preempted" || reason === "") {
        return renderReasonTemplate(
          t("scaling.reason.spot_preempted", { n: requeued }),
        );
      }
      return summarisePayload(p, t);
    }
    case "node_replaced":
      return renderReasonTemplate(t("scaling.reason.replacement"));
    case "node_provisioned":
      return summarisePayload(p, t);
    default:
      return summarisePayload(p, t);
  }
}

/**
 * Render a reason template that contains `code` segments around tokens like
 * `tasks {N}` or `idle {N}s`. We highlight any number-like substring as a
 * `<code>` token for readability, matching the mockup's typography.
 */
function renderReasonTemplate(template: string): ReactNode {
  // Split on number-or-word tokens but preserve them in the output.
  const parts = template.split(/(\b\d+[a-z]*\b|spot_preempted|idle_timeout|max_nodes|min_ready|target|concurrency|backlog)/i);
  return parts.map((seg, i) => {
    if (i % 2 === 1 && seg) {
      return <code key={i}>{seg}</code>;
    }
    return <span key={i}>{seg}</span>;
  });
}

function summarisePayload(
  payload: Record<string, unknown>,
  t: TFn,
): ReactNode {
  const entries = Object.entries(payload).slice(0, 4);
  if (entries.length === 0) return <span>—</span>;
  return (
    <>
      <span>{t("scaling.reason.payload")}: </span>
      {entries.map(([k, v], i) => (
        <span key={k}>
          {i > 0 ? " · " : ""}
          <code>{k}={truncate(formatValue(v), 24)}</code>
        </span>
      ))}
    </>
  );
}

function numberFrom(
  payload: Record<string, unknown>,
  keys: string[],
  fallback: number,
): number {
  for (const k of keys) {
    const v = payload[k];
    if (typeof v === "number" && Number.isFinite(v)) return v;
    if (typeof v === "string") {
      const parsed = Number(v);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return fallback;
}

function stringFrom(
  payload: Record<string, unknown>,
  keys: string[],
  fallback: string,
): string {
  for (const k of keys) {
    const v = payload[k];
    if (typeof v === "string") return v;
  }
  return fallback;
}

function shortNodeId(payload: Record<string, unknown>): string {
  const id = stringFrom(payload, ["node_id", "node", "id"], "");
  if (id.length <= 12) return id || "—";
  return id.slice(0, 10) + "…";
}

function formatValue(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}…`;
}
