import type { ReactNode } from "react";
import { Sparkline } from "./Sparkline";

interface KpiCardProps {
  label: string;
  value: ReactNode;
  unit?: string;
  detail?: ReactNode;
  tone?: "ok" | "warn" | "bad" | "neutral";
  /** Optional sparkline data — last N samples in chronological order. */
  sparkline?: ReadonlyArray<number>;
  /** Optional click handler — when set, the card becomes a drill-down. */
  onClick?: () => void;
  /** Accessible label used when the card is clickable. */
  clickHint?: string;
}

export function KpiCard({
  label,
  value,
  unit,
  detail,
  tone = "neutral",
  sparkline,
  onClick,
  clickHint,
}: KpiCardProps) {
  const drillable = !!onClick;
  const handleKey = drillable
    ? (event: React.KeyboardEvent<HTMLDivElement>) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onClick?.();
        }
      }
    : undefined;
  return (
    <div
      className={`kpi kpi-card ${tone !== "neutral" ? `tone-${tone}` : ""} ${
        drillable ? "kpi-drillable" : ""
      }`}
      role={drillable ? "button" : undefined}
      tabIndex={drillable ? 0 : undefined}
      onClick={drillable ? onClick : undefined}
      onKeyDown={handleKey}
      title={drillable ? clickHint : undefined}
      aria-label={drillable && clickHint ? `${label} — ${clickHint}` : undefined}
    >
      <div className="l">{label}</div>
      <div className="v">
        {value}
        {unit && <small>{unit}</small>}
      </div>
      {detail && <div className={`d${tone !== "neutral" ? " " + tone : ""}`}>{detail}</div>}
      {sparkline && sparkline.length > 0 && (
        <Sparkline values={sparkline} width={140} height={26} ariaLabel={label} />
      )}
    </div>
  );
}

