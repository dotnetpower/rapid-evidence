import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type BackgroundJob } from "../../lib/api";
import { useI18n } from "../../lib/i18n";
import { timeAgo } from "../../lib/format";

const DEFAULT_REGIONS_COUNT = 17;

function summariseResult(job: BackgroundJob): string {
  if (job.error) return job.error;
  const r = job.result;
  if (!r) return "—";
  if (typeof r === "object" && "totals" in r) {
    const totals = (r as { totals?: { limit?: number; used?: number; headroom?: number; regions_observed?: number; regions_total?: number } }).totals ?? {};
    const observed = totals.regions_observed ?? 0;
    const total = totals.regions_total ?? 0;
    return `obs ${observed}/${total} · limit ${totals.limit ?? 0} · headroom ${totals.headroom ?? 0}`;
  }
  if (typeof r === "object" && "status" in r) {
    return String((r as { status?: string }).status ?? "");
  }
  if (typeof r === "object" && "value" in r) {
    return String((r as { value?: string }).value ?? "");
  }
  return "ok";
}

export function JobsPanel() {
  const { t } = useI18n();
  const qc = useQueryClient();

  const jobs = useQuery({
    queryKey: ["jobs"],
    queryFn: () => api.jobsList(50),
    refetchInterval: 4000,
    staleTime: 2000,
  });

  const probe = useMutation({
    mutationFn: () => api.quotaProbeRegions({ regions: null }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["jobs"] });
      qc.invalidateQueries({ queryKey: ["quota-status"] });
      qc.invalidateQueries({ queryKey: ["regions-status"] });
    },
  });

  const rows = jobs.data?.jobs ?? [];
  const ordered = [...rows].reverse();

  return (
    <section className="panel" style={{ marginTop: 16 }}>
      <div className="panel-head">
        <span className="title">{t("jobs.panel.title")}</span>
        <span className="meta">{rows.length}</span>
      </div>
      <div style={{ padding: 14 }}>
        <div className="jobs-probe">
          <div className="jobs-probe__head">
            <span>{t("jobs.probe.title")}</span>
            <button
              className="btn primary"
              onClick={() => probe.mutate()}
              disabled={probe.isPending}
            >
              {probe.isPending ? t("jobs.probe.running") : t("jobs.probe.button")}
            </button>
          </div>
          <div className="jobs-probe__hint">
            {t("jobs.probe.hint", { count: DEFAULT_REGIONS_COUNT })}
          </div>
          {probe.error ? (
            <div className="error-banner" style={{ marginTop: 8 }}>
              {(probe.error as Error).message}
            </div>
          ) : null}
        </div>
        {ordered.length === 0 ? (
          <div className="empty" style={{ marginTop: 12 }}>
            {t("jobs.panel.empty")}
          </div>
        ) : (
          <table className="batches" style={{ marginTop: 12 }}>
            <thead>
              <tr>
                <th>{t("jobs.col.name")}</th>
                <th style={{ width: 90 }}>{t("jobs.col.status")}</th>
                <th style={{ width: 120 }}>{t("jobs.col.started")}</th>
                <th style={{ width: 90 }}>{t("jobs.col.duration")}</th>
                <th>{t("jobs.col.summary")}</th>
              </tr>
            </thead>
            <tbody>
              {ordered.map((job) => (
                <tr key={job.job_id}>
                  <td className="id-cell">
                    <div className="id">{job.name}</div>
                    <div className="src" style={{ opacity: 0.5 }}>
                      {job.job_id}
                    </div>
                  </td>
                  <td>
                    <span className={`pill ${jobStatusClass(job.status)}`}>
                      {t(`jobs.status.${job.status}`)}
                    </span>
                  </td>
                  <td>{timeAgo(job.started_at)}</td>
                  <td style={{ fontVariantNumeric: "tabular-nums" }}>
                    {job.duration_seconds == null
                      ? "—"
                      : job.duration_seconds < 1
                      ? `${(job.duration_seconds * 1000).toFixed(0)}ms`
                      : `${job.duration_seconds.toFixed(1)}s`}
                  </td>
                  <td style={{ fontSize: 11, opacity: 0.85 }}>{summariseResult(job)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </section>
  );
}

function jobStatusClass(status: BackgroundJob["status"]): string {
  switch (status) {
    case "succeeded":
      return "ok";
    case "failed":
      return "bad";
    case "cancelled":
      return "";
    default:
      return "warn";
  }
}
