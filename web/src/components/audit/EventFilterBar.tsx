import { useI18n } from "../../lib/i18n";

interface Props {
  available: string[];
  selected: Set<string>;
  onToggle: (eventType: string) => void;
  onReset: () => void;
  /** Per-event-type counts; falls back to no badge when omitted. */
  counts?: Record<string, number>;
  /** Total events in the buffer (shown next to the "all" chip). */
  total?: number;
}

export function EventFilterBar({
  available,
  selected,
  onToggle,
  onReset,
  counts,
  total,
}: Props) {
  const { t } = useI18n();
  return (
    <div className="event-filter-bar" role="group" aria-label={t("audit.filter.event")}>
      <button
        type="button"
        className={`event-filter-chip${selected.size === 0 ? " on" : ""}`}
        onClick={onReset}
      >
        {t("audit.filter.all")}
        {typeof total === "number" && (
          <span style={{ opacity: 0.65, marginLeft: 4, fontVariantNumeric: "tabular-nums" }}>
            · {total}
          </span>
        )}
      </button>
      {available.map((evt) => {
        const n = counts?.[evt];
        return (
          <button
            key={evt}
            type="button"
            className={`event-filter-chip${selected.has(evt) ? " on" : ""}`}
            onClick={() => onToggle(evt)}
            aria-pressed={selected.has(evt)}
          >
            {evt}
            {typeof n === "number" && (
              <span style={{ opacity: 0.65, marginLeft: 4, fontVariantNumeric: "tabular-nums" }}>
                · {n}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

