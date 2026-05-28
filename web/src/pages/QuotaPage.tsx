import { useI18n } from "../lib/i18n";

export function QuotaPage() {
  const { t } = useI18n();
  return (
    <div className="page-head">
      <div>
        <h1>{t("quota.page.title")}</h1>
        <div className="sub">{t("quota.page.sub")}</div>
      </div>
    </div>
  );
}
