import { useI18n } from "../../lib/i18n";
import type { RegionSummary } from "../../lib/api";

interface RegionCardProps {
  summary: RegionSummary;
  selected: boolean;
  onClick: () => void;
}

export function RegionCard({ summary, selected, onClick }: RegionCardProps) {
  const { t } = useI18n();
  const region = summary.region || t("regions.unknown");
  const evicting = summary.evictions_recent > 0;
  return (
    <button
      type="button"
      className={`region-card${selected ? " selected" : ""}${evicting ? " warn" : ""}`}
      onClick={onClick}
    >
      <div className="region-card__head">
        <span className="region-card__name">{region}</span>
        <span className="region-card__count">
          {summary.nodes} {t("regions.card.nodes")}
        </span>
      </div>
      <div className="region-card__row">
        <span className="dot ok" />
        <span className="region-card__lbl">{t("regions.card.ready")}</span>
        <span className="region-card__val">{summary.ready}</span>
      </div>
      <div className="region-card__row">
        <span className="dot violet" />
        <span className="region-card__lbl">{t("regions.card.busy")}</span>
        <span className="region-card__val">{summary.busy}</span>
      </div>
      <div className="region-card__row">
        <span className={`dot ${evicting ? "warn" : ""}`} />
        <span className="region-card__lbl">{t("regions.card.evictions")}</span>
        <span className="region-card__val">{summary.evictions_recent}</span>
      </div>
    </button>
  );
}
