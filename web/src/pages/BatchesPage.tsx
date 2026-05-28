import { useI18n } from "../lib/i18n";

export function BatchesPage() {
  const { t } = useI18n();
  return (
    <div className="page-head">
      <div>
        <h1>{t("batches.page.title")}</h1>
        <div className="sub">{t("batches.page.sub")}</div>
      </div>
    </div>
  );
}
