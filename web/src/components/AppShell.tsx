import { Link, NavLink, Outlet, useLocation } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";
import { formatDuration, formatNumber, formatRate, timeAgo } from "../lib/format";
import { useI18n } from "../lib/i18n";
import { useNowTick } from "../lib/useNowTick";

interface NavItem {
  to: string;
  labelKey: string;
  icon: string;
  disabled?: boolean;
}

const navItems: NavItem[] = [
  { to: "/", labelKey: "title.crumb.throughput", icon: "≡" },
  { to: "/regions", labelKey: "title.crumb.regions", icon: "▦" },
  { to: "/batches", labelKey: "title.crumb.batches", icon: "⛁" },
  { to: "/scaling", labelKey: "title.crumb.scaling", icon: "▥" },
  { to: "/quota", labelKey: "title.crumb.quota", icon: "▤" },
  { to: "/audit", labelKey: "title.crumb.audit", icon: "⏚" },
];

function crumbKey(pathname: string): string {
  if (pathname === "/" || pathname === "") return "title.crumb.throughput";
  const m = navItems.find((n) => n.to === pathname);
  return m?.labelKey ?? "title.crumb.unknown";
}

export function AppShell() {
  const location = useLocation();
  const { t, lang, setLang } = useI18n();
  const now = useNowTick(1000);

  const summary = useQuery({
    queryKey: ["dashboard-summary"],
    queryFn: () => api.dashboardSummary(),
    refetchInterval: 2000,
    refetchIntervalInBackground: false,
    staleTime: 1500,
  });
  const jobs = useQuery({
    queryKey: ["jobs", "appshell"],
    queryFn: () => api.jobsList(50),
    refetchInterval: 5000,
    refetchIntervalInBackground: false,
    staleTime: 3000,
  });
  const runningJobs = (jobs.data?.jobs ?? []).filter((j) => j.status === "running").length;
  const failedJobs = (jobs.data?.jobs ?? [])
    .slice(-10)
    .filter((j) => j.status === "failed").length;

  const sample = summary.data?.latest_sample;
  const interval = summary.data?.sample_interval_seconds;
  const everConnected = summary.dataUpdatedAt > 0;
  const connected = summary.isSuccess && summary.data?.pool?.running !== undefined;
  const status: "connected" | "connecting" | "disconnected" = connected
    ? "connected"
    : everConnected
    ? "disconnected"
    : "connecting";
  const statusLabel =
    status === "connected"
      ? `${t("status.connected")} ${interval ? `${interval}s` : ""}`
      : status === "connecting"
      ? t("status.connecting")
      : t("status.disconnected");

  return (
    <div className="app">
      <div className="titlebar">
        <span className="brand">rapid-evidence</span>
        <span>
          {t("title.ops")} / <b>{t(crumbKey(location.pathname))}</b>
        </span>
        <span className="right">
          <span
            className="lang-toggle"
            role="group"
            aria-label="language"
            style={{ display: "inline-flex", gap: 4 }}
          >
            <button
              type="button"
              className={`btn lang-btn${lang === "en" ? " on" : ""}`}
              onClick={() => setLang("en")}
              aria-pressed={lang === "en"}
              title="English"
            >
              {t("lang.en")}
            </button>
            <button
              type="button"
              className={`btn lang-btn${lang === "ko" ? " on" : ""}`}
              onClick={() => setLang("ko")}
              aria-pressed={lang === "ko"}
              title="한국어"
            >
              {t("lang.ko")}
            </button>
          </span>
          <span
            className={`led${status === "connected" ? "" : status === "connecting" ? " warming" : " off"}`}
          >
            {statusLabel}
          </span>
          {summary.data?.pool?.provider && (
            <span>
              {t("status.provider")}: {summary.data.pool.provider}
            </span>
          )}
        </span>
      </div>

      <aside className="sidebar">
        {navItems.map((item) =>
          item.disabled ? (
            <span
              key={item.to}
              className="nav"
              title={t("nav.notImplemented")}
              style={{ opacity: 0.45, cursor: "default" }}
            >
              <span className="ic">{item.icon}</span> {t(item.labelKey)}
            </span>
          ) : (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.to === "/"}
              className={({ isActive }) => `nav${isActive ? " active" : ""}`}
            >
              <span className="ic">{item.icon}</span> {t(item.labelKey)}
            </NavLink>
          )
        )}
        <div className="section">{t("nav.session")}</div>
        <span className="nav" style={{ cursor: "default" }}>
          <span className="ic">●</span> {t("nav.autorefresh")}
        </span>
      </aside>

      <main className="content">
        <Outlet context={summary} />
      </main>

      <div className="statusbar">
        <span className="seg">
          ⎈ {t("bar.pool")}{" "}
          {summary.data?.pool?.counters
            ? `${
                (summary.data.pool.counters.ready ?? 0) +
                (summary.data.pool.counters.busy ?? 0) +
                (summary.data.pool.counters.provisioning ?? 0) +
                (summary.data.pool.counters.draining ?? 0)
              } ${t("bar.poolActive")}`
            : "—"}
        </span>
        <span className="seg">⇅ {formatRate(summary.data?.throughput_per_second)}</span>
        <span className="seg">
          {t("bar.backlog")} {formatNumber(summary.data?.backlog ?? 0)}
        </span>
        <span className="seg">
          {t("bar.drainEta")} {formatDuration(summary.data?.drain_eta_seconds ?? null)}
        </span>
        <Link to="/quota" className="seg" title={t("bar.jobsTooltip")}>
          ⚙ {t("bar.jobs")} {runningJobs}
          {failedJobs > 0 && (
            <span style={{ marginLeft: 4, color: "#ffd1d6" }}>
              · {failedJobs} {t("bar.failed")}
            </span>
          )}
        </Link>
        <span className="seg" style={{ marginLeft: "auto" }}>
          {t("bar.lastSample")} {timeAgo(sample?.timestamp ?? null, now)}
        </span>
      </div>
    </div>
  );
}
