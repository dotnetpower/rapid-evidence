import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type DashboardSummary } from "../lib/api";
import { useI18n } from "../lib/i18n";
import { QuotaMeter } from "../components/quota/QuotaMeter";
import { timeAgo } from "../lib/format";
import "../styles/quota-regions.css";

export function QuotaPage() {
  const { t } = useI18n();
  const qc = useQueryClient();
  const quota = useQuery({
    queryKey: ["quota-status"],
    queryFn: () => api.quotaStatus(),
    refetchInterval: 30000,
    staleTime: 15000,
  });
  const summary = useQuery({
    queryKey: ["dashboard-summary"],
    queryFn: () => api.dashboardSummary(),
    refetchInterval: 5000,
  });

  const provider = (summary.data as DashboardSummary | undefined)?.pool?.provider;
  const status = quota.data;

  return (
    <>
      <div className="page-head">
        <div>
          <h1>{t("quota.page.title")}</h1>
          <div className="sub">{t("quota.page.sub")}</div>
        </div>
        <div className="actions">
          <button
            className="btn"
            onClick={() => {
              quota.refetch();
              qc.invalidateQueries({ queryKey: ["dashboard-summary"] });
            }}
            disabled={quota.isFetching}
          >
            ⟳ {t("quota.refresh")}
          </button>
        </div>
      </div>

      {!status || !status.observed ? (
        <div className="panel">
          <div className="empty">
            {t("quota.notObserved")}
            {provider ? <div style={{ opacity: 0.6, marginTop: 6 }}>provider: {provider}</div> : null}
          </div>
        </div>
      ) : (
        <div className="panel">
          <div className="panel-head">
            <span className="title">
              {provider ? `provider: ${provider}` : t("quota.page.title")}
            </span>
            <span className="meta">
              {t("quota.checked")}:{" "}
              {status.checked_at ? timeAgo(status.checked_at) : t("quota.never")}
            </span>
          </div>
          <div style={{ padding: 14 }}>
            <QuotaMeter status={status} />
            {status.error ? (
              <div className="error-banner" style={{ marginTop: 12 }}>
                {t("quota.error")}: {status.error}
              </div>
            ) : null}
          </div>
        </div>
      )}
    </>
  );
}
