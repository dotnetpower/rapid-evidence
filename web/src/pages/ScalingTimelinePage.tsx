import { useI18n } from "../lib/i18n";

export function ScalingTimelinePage() {
  const { t } = useI18n();
  return (
    <div className="page-head">
      <div>
        <h1>{t("scaling.page.title")}</h1>
        <div className="sub">{t("scaling.page.sub")}</div>
      </div>
    </div>
  );
}
