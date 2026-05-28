import { useI18n } from "../../lib/i18n";
import type { QuotaStatus } from "../../lib/api";

interface QuotaMeterProps {
  status: QuotaStatus;
}

function pct(used?: number, limit?: number): number {
  if (!used || !limit || limit <= 0) return 0;
  return Math.min(100, Math.max(0, (used / limit) * 100));
}

export function QuotaMeter({ status }: QuotaMeterProps) {
  const { t } = useI18n();
  const used = status.used ?? 0;
  const limit = status.limit ?? 0;
  const ratio = pct(used, limit);
  const sufficient = status.is_sufficient ?? ratio < 95;
  const tone = ratio >= 95 ? "bad" : ratio >= 80 ? "warn" : "ok";
  return (
    <div className="quota-meter">
      <div className="quota-meter__head">
        <span className="quota-meter__label">{t("quota.meter.label")}</span>
        <span className={`pill ${sufficient ? "ok" : "bad"}`}>
          {sufficient ? t("quota.meter.sufficient") : t("quota.meter.insufficient")}
        </span>
      </div>
      <div className={`meter ${tone}`}>
        <span style={{ width: `${ratio}%` }} />
      </div>
      <div className="quota-meter__numbers">
        <span>
          {used} / {limit}
        </span>
        <span style={{ opacity: 0.7 }}>
          {t("quota.headroom")} {Math.max(0, limit - used)}
        </span>
      </div>
      <div className="quota-meter__checks">
        <span className={status.spot_quota_observed ? "ok" : "off"}>
          {status.spot_quota_observed ? "✓" : "·"} {t("quota.spot_observed")}
        </span>
        <span className={status.public_ip_quota_observed ? "ok" : "off"}>
          {status.public_ip_quota_observed ? "✓" : "·"} {t("quota.ip_observed")}
        </span>
      </div>
    </div>
  );
}
