import { useI18n } from "../lib/i18n";

export function AuditPage() {
  const { t } = useI18n();
  return (
    <div className="page-head">
      <div>
        <h1>{t("audit.page.title")}</h1>
        <div className="sub">{t("audit.page.sub")}</div>
      </div>
    </div>
  );
}
