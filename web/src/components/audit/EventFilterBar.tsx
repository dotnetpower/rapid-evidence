import { useI18n } from "../../lib/i18n";

interface Props {
  available: string[];
  selected: Set<string>;
  onToggle: (eventType: string) => void;
  onReset: () => void;
}

export function EventFilterBar({ available, selected, onToggle, onReset }: Props) {
  const { t } = useI18n();
  return (
    <div className="event-filter-bar" role="group" aria-label={t("audit.filter.event")}>
      <button
        type="button"
        className={`event-filter-chip${selected.size === 0 ? " on" : ""}`}
        onClick={onReset}
      >
        {t("audit.filter.all")}
      </button>
      {available.map((evt) => (
        <button
          key={evt}
          type="button"
          className={`event-filter-chip${selected.has(evt) ? " on" : ""}`}
          onClick={() => onToggle(evt)}
          aria-pressed={selected.has(evt)}
        >
          {evt}
        </button>
      ))}
    </div>
  );
}
