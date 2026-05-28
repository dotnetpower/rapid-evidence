import { type BatchTimelineEvent } from "../../lib/api";
import { useI18n } from "../../lib/i18n";

interface Props {
  events: BatchTimelineEvent[] | undefined;
  isLoading: boolean;
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleTimeString(undefined, { hour12: false });
}

function summarisePayload(payload: Record<string, unknown>): string {
  const entries = Object.entries(payload);
  if (entries.length === 0) return "";
  return entries
    .map(([k, v]) => {
      if (Array.isArray(v)) return `${k}=[${v.length}]`;
      if (v && typeof v === "object") return `${k}=${JSON.stringify(v)}`;
      return `${k}=${String(v)}`;
    })
    .join(" · ");
}

export function BatchTimelineList({ events, isLoading }: Props) {
  const { t } = useI18n();
  if (isLoading) {
    return <div className="empty">{t("batches.drawer.timeline.loading")}</div>;
  }
  if (!events || events.length === 0) {
    return <div className="empty">{t("batches.drawer.timeline.empty")}</div>;
  }
  // Reverse-chrono — newest first. Don't mutate the original array.
  const reversed = [...events].reverse();
  return (
    <ol className="drawer-timeline">
      {reversed.map((e, idx) => (
        <li key={`${e.timestamp}-${idx}`}>
          <span className="ts">{formatTime(e.timestamp)}</span>
          <span className="et">{e.event_type}</span>
          <span className="pl">{summarisePayload(e.payload)}</span>
        </li>
      ))}
    </ol>
  );
}
