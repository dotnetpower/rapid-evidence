import type { ReactNode } from "react";

interface KpiCardProps {
  label: string;
  value: ReactNode;
  unit?: string;
  detail?: ReactNode;
  tone?: "ok" | "warn" | "bad" | "neutral";
}

export function KpiCard({ label, value, unit, detail, tone = "neutral" }: KpiCardProps) {
  return (
    <div className="kpi">
      <div className="l">{label}</div>
      <div className="v">
        {value}
        {unit && <small>{unit}</small>}
      </div>
      {detail && <div className={`d${tone !== "neutral" ? " " + tone : ""}`}>{detail}</div>}
    </div>
  );
}
