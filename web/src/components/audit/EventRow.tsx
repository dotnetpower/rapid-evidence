import { useMemo, useState } from "react";
import type { RuntimeEvent } from "../../lib/api";
import { timeAgo } from "../../lib/format";
import { useI18n } from "../../lib/i18n";
import { useNowTick } from "../../lib/useNowTick";
import { useToast } from "../../lib/useToast";

interface Props {
  event: RuntimeEvent;
}

function formatAbsolute(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString("en-US", { hour12: false });
}

async function copyToClipboard(text: string): Promise<boolean> {
  // navigator.clipboard requires a secure context; fall back to a temp textarea.
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // fall through
    }
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

export function EventRow({ event }: Props) {
  const [open, setOpen] = useState(false);
  const { t } = useI18n();
  const now = useNowTick(1000);
  const toast = useToast();
  // Memoise: serialising 500 visible rows on every parent re-render
  // (every audit poll tick) was previously ~500 JSON.stringify calls
  // per second under load. Now bound to payload identity.
  const payloadText = useMemo(
    () => JSON.stringify(event.payload ?? {}, null, 2),
    [event.payload],
  );
  const hasPayload = payloadText !== "{}";

  async function handleCopy() {
    const ok = await copyToClipboard(payloadText);
    toast(
      ok ? t("audit.payload.copied") : t("audit.payload.copyFailed"),
      ok ? "success" : "error",
    );
  }

  return (
    <li className="event-row">
      <div className="event-row__head">
        <span className="event-row__time" title={formatAbsolute(event.timestamp)}>
          <span className="event-row__time-rel">{timeAgo(event.timestamp, now)}</span>
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
            title={open ? t("audit.payload.hide") : t("audit.payload.show")}
          >
            <span
              aria-hidden="true"
              style={{
                marginRight: 4,
                display: "inline-block",
                transform: open ? "rotate(90deg)" : "rotate(0deg)",
                transition: "transform 100ms ease",
              }}
            >
              ▸
            </span>
            {open ? t("audit.payload.hide") : t("audit.payload.show")}
          </button>
        )}
        {hasPayload && (
          <button
            type="button"
            className="copy-btn"
            onClick={handleCopy}
            title={t("audit.payload.copy")}
          >
            ⧉ {t("audit.payload.copy")}
          </button>
        )}
      </div>
      {open && hasPayload && (
        <pre className="event-row__payload">{payloadText}</pre>
      )}
    </li>
  );
}

