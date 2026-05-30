/**
 * SnapshotRibbons — current pool snapshot, normalized to `max_nodes`.
 *
 * Each ribbon shows one pool state (ready/busy/prov/drain + total active)
 * as a 0..max bar with three tick marks: floor (`min_ready`), target
 * (scheduler intent), and ceiling (`max_nodes`). When `config` is absent
 * (pool not running) the component renders an explanatory empty state
 * instead of misleading zero-bars.
 */
import type { PoolBlock, ScaleTarget } from "../../lib/api";
import { useI18n } from "../../lib/i18n";

interface Props {
  pool: PoolBlock | undefined;
  scaleTarget: ScaleTarget | null | undefined;
}

interface RibbonInput {
  key: string;
  labelKey: string;
  value: number;
  fill: "ready" | "busy" | "prov" | "drain";
}

export function SnapshotRibbons({ pool, scaleTarget }: Props) {
  const { t } = useI18n();
  const config = pool?.config;
  if (!config || !pool?.running) {
    return <div className="ribbons ribbons--empty">{t("scaling.snapshot.noConfig")}</div>;
  }

  const counters = pool.counters ?? {};
  const ready = Number(counters.ready ?? 0);
  const busy = Number(counters.busy ?? 0);
  const prov = Number(counters.provisioning ?? 0);
  // NOTE: `drain` intentionally excludes `terminating` so the "total active"
  // here matches the backend's `MetricSample.active_vms` definition
  // (ready + busy + prov + drain) drawn by SwimlaneChart. Terminating nodes
  // are on their way out and should not inflate active capacity.
  const drain = Number(counters.draining ?? 0);
  const totalActive = ready + busy + prov + drain;

  const max = Math.max(1, config.max_nodes); // guard div-by-zero
  const minPct = clampPct((config.min_ready / max) * 100);
  // Hide the target tick entirely when no live scaleTarget is available;
  // a fallback to max_nodes would visually collide with the ceiling tick
  // and falsely imply the scheduler intends to scale to ceiling.
  const targetPct: number | null =
    scaleTarget && typeof scaleTarget.target_nodes === "number"
      ? clampPct((scaleTarget.target_nodes / max) * 100)
      : null;

  const rows: RibbonInput[] = [
    { key: "ready", labelKey: "scaling.snapshot.ready", value: ready, fill: "ready" },
    { key: "busy", labelKey: "scaling.snapshot.busy", value: busy, fill: "busy" },
    { key: "prov", labelKey: "scaling.snapshot.prov", value: prov, fill: "prov" },
    { key: "drain", labelKey: "scaling.snapshot.drain", value: drain, fill: "drain" },
  ];

  return (
    <div className="ribbons">
      {rows.map((row) => (
        <Ribbon
          key={row.key}
          label={t(row.labelKey)}
          value={row.value}
          max={max}
          minPct={minPct}
          targetPct={targetPct}
          fillVariant={row.fill}
        />
      ))}
      <Ribbon
        label={t("scaling.snapshot.totalActive")}
        value={totalActive}
        max={max}
        minPct={minPct}
        targetPct={targetPct}
        fillVariant="total"
        isTotal
      />
    </div>
  );
}

interface RibbonProps {
  label: string;
  value: number;
  max: number;
  minPct: number;
  targetPct: number | null;
  fillVariant: "ready" | "busy" | "prov" | "drain" | "total";
  isTotal?: boolean;
}

function Ribbon({
  label,
  value,
  max,
  minPct,
  targetPct,
  fillVariant,
  isTotal,
}: RibbonProps) {
  const widthPct = clampPct((value / max) * 100);
  return (
    <div className={`ribbon-row${isTotal ? " ribbon-row--total" : ""}`}>
      <span className="ribbon-row__lbl">{label}</span>
      <div className="ribbon-bar">
        <div
          className={`ribbon-bar__fill ribbon-bar__fill--${fillVariant}`}
          style={{ width: `${widthPct}%` }}
        />
        <span className="ribbon-bar__tick ribbon-bar__tick--min" style={{ left: `${minPct}%` }} />
        {targetPct !== null && (
          <span className="ribbon-bar__tick ribbon-bar__tick--target" style={{ left: `${targetPct}%` }} />
        )}
        <span className="ribbon-bar__tick ribbon-bar__tick--max" style={{ left: "100%" }} />
      </div>
      <span className="ribbon-row__num">{value} / {max}</span>
    </div>
  );
}

function clampPct(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(100, v));
}
