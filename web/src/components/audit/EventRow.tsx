import { useState } from "react";
import type { RuntimeEvent } from "../../lib/api";
import { timeAgo } from "../../lib/format";
import { useI18n } from "../../lib/i18n";

interface Props {
  event: RuntimeEvent;
}

function formatAbsolute(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString("en-US", { hour12: false });
}

export function EventRow({ event }: Props) {
  const [open, setOpen] = useState(false);
  const { t } = useI18n();
  const payloadText = JSON.stringify(event.payload ?? {}, null, 2);
  const hasPayload = payloadText !== "{}";

  return (
    <li className="event-row">
      <div className="event-row__head">
        <span className="event-row__time" title={formatAbsolute(event.timestamp)}>
          <span className="event-row__time-rel">{timeAgo(event.timestamp)}</span>
          <span className="event-row__time-abs">{formatAbsolute(event.timestamp)}</span>
        </span>
        <span className={`event-row__type event-row__type--${event.event_type}`}>
          {event.event_type}
        </span>
        {hasPayload && (
          <button
            type="button"
            className="event-row__toggle"
            onClick={() => setOpen((prev) => !prev)}
            aria-expanded={open}
          >
            {open ? t("audit.payload.hide") : t("audit.payload.show")}
          </button>
        )}
      </div>
      {open && hasPayload && (
        <pre className="event-row__payload">{payloadText}</pre>
      )}
    </li>
  );
}
