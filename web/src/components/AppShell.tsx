import { NavLink, Outlet, useLocation } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";
import { formatDuration, formatNumber, formatRate, timeAgo } from "../lib/format";

const navItems = [
  { to: "/", label: "Throughput", icon: "≡" },
  { to: "/regions", label: "Regions", icon: "▦", disabled: true },
  { to: "/batches", label: "Batches", icon: "⛁", disabled: true },
  { to: "/scaling", label: "Scaling Timeline", icon: "▥", disabled: true },
  { to: "/quota", label: "Quota", icon: "▤", disabled: true },
  { to: "/audit", label: "Audit", icon: "⏚", disabled: true },
];

export function AppShell() {
  const location = useLocation();

  const summary = useQuery({
    queryKey: ["dashboard-summary"],
    queryFn: () => api.dashboardSummary(),
    refetchInterval: 2000,
    refetchIntervalInBackground: false,
    staleTime: 1500,
  });

  const sample = summary.data?.latest_sample;
  const interval = summary.data?.sample_interval_seconds;
  const connected = summary.isSuccess && summary.data?.pool?.running !== undefined;

  return (
    <div className="app">
      <div className="titlebar">
        <span className="brand">rapid-evidence</span>
        <span>
          Operations / <b>{crumbFor(location.pathname)}</b>
        </span>
        <span className="right">
          <span className={`led${connected ? "" : " off"}`}>
            {connected
              ? `connected · /dashboard/summary ${interval ? `${interval}s` : ""}`
              : "disconnected"}
          </span>
          {summary.data?.pool?.provider && (
            <span>provider: {summary.data.pool.provider}</span>
          )}
        </span>
      </div>

      <aside className="sidebar">
        {navItems.map((item) =>
          item.disabled ? (
            <span key={item.to} className="nav" title="아직 구현되지 않음" style={{ opacity: 0.45, cursor: "default" }}>
              <span className="ic">{item.icon}</span> {item.label}
            </span>
          ) : (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.to === "/"}
              className={({ isActive }) => `nav${isActive ? " active" : ""}`}
            >
              <span className="ic">{item.icon}</span> {item.label}
            </NavLink>
          )
        )}
        <div className="section">Session</div>
        <span className="nav" style={{ cursor: "default" }}>
          <span className="ic">●</span> Auto-refresh 2s
        </span>
      </aside>

      <main className="content">
        <Outlet context={summary} />
      </main>

      <div className="statusbar">
        <span className="seg">
          ⎈ pool {summary.data?.pool?.counters
            ? `${(summary.data.pool.counters.ready ?? 0) +
                (summary.data.pool.counters.busy ?? 0) +
                (summary.data.pool.counters.provisioning ?? 0) +
                (summary.data.pool.counters.draining ?? 0)} active`
            : "—"}
        </span>
        <span className="seg">⇅ {formatRate(summary.data?.throughput_per_second)}</span>
        <span className="seg">backlog {formatNumber(summary.data?.backlog ?? 0)}</span>
        <span className="seg">
          drain ETA {formatDuration(summary.data?.drain_eta_seconds ?? null)}
        </span>
        <span className="seg" style={{ marginLeft: "auto" }}>
          last sample {timeAgo(sample?.timestamp ?? null)}
        </span>
      </div>
    </div>
  );
}

function crumbFor(pathname: string): string {
  if (pathname === "/" || pathname === "") return "Throughput";
  const m = navItems.find((n) => n.to === pathname);
  return m?.label ?? "Unknown";
}
