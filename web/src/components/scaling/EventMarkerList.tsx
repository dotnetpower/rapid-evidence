import type { RuntimeEvent } from "../../lib/api";
import { timeAgo } from "../../lib/format";
import { useI18n } from "../../lib/i18n";

interface Props {
  events: RuntimeEvent[];
}

function formatAbsolute(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString("en-US", { hour12: false });
}

export function EventMarkerList({ events }: Props) {
  const { t } = useI18n();
  if (!events || events.length === 0) {
    return (
      <div className="event-marker-list event-marker-list--empty">
        {t("scaling.markers.empty")}
      </div>
    );
  }
  // Newest first; bounded by the api response size (server already limits).
  const sorted = [...events].sort((a, b) =>
    a.timestamp < b.timestamp ? 1 : a.timestamp > b.timestamp ? -1 : 0,
  );
  return (
    <ul className="event-marker-list">
      {sorted.map((event, idx) => (
        <li
          key={`${event.timestamp}|${event.event_type}|${idx}`}
          className="event-marker-list__row"
        >
          <span
            className={`event-marker-list__pill event-marker-list__pill--${event.event_type}`}
          >
            {event.event_type}
          </span>
          <span
            className="event-marker-list__time"
            title={formatAbsolute(event.timestamp)}
          >
            {timeAgo(event.timestamp)}
          </span>
          <span className="event-marker-list__payload" title={JSON.stringify(event.payload ?? {})}>
            {summarisePayload(event.payload)}
          </span>
        </li>
      ))}
    </ul>
  );
}

function summarisePayload(payload: Record<string, unknown> | undefined | null): string {
  if (!payload) return "";
  const entries = Object.entries(payload);
  if (entries.length === 0) return "";
  return entries
    .slice(0, 4)
    .map(([k, v]) => `${k}=${truncate(formatValue(v), 30)}`)
    .join(" · ");
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
