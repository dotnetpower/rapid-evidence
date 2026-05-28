import { useI18n } from "../lib/i18n";

export function RegionsPage() {
  const { t } = useI18n();
  return (
    <div className="page-head">
      <div>
        <h1>{t("regions.page.title")}</h1>
        <div className="sub">{t("regions.page.sub")}</div>
      </div>
    </div>
  );
}
