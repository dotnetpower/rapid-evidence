/**
 * SwimlaneChart — v3-2 "Tide Chart" SVG renderer.
 *
 * Renders a single-pane time-axis visualisation of pool capacity:
 *   • floor (`min_ready`) and ceiling (`max_nodes`) reference bands
 *   • active VMs as a filled area (sum of ready + busy + prov + drain)
 *   • dashed scheduler-intent target line (`ceil(backlog/concurrency)` clamped)
 *   • event glyphs (▲ scale_up, ▼ scale_down, ● eviction, ◇ replaced, ○ provisioned)
 *   • right-edge "now" cursor
 *
 * Pure geometry lives in `swimlanePaths.ts`; this component only renders the
 * resulting `TidePlan` and the legend bar. No recharts dependency.
 */
import { useMemo } from "react";
import type {
  MetricSample,
  PoolConfig,
  RuntimeEvent,
  ScaleTarget,
} from "../../lib/api";
import { useI18n } from "../../lib/i18n";
import {
  buildTidePlan,
  TIDE_VIEW,
  type EventMarker,
} from "./swimlanePaths";

interface Props {
  samples: MetricSample[];
  events: RuntimeEvent[];
  config?: PoolConfig | undefined;
  scaleTarget?: ScaleTarget | null | undefined;
}

export function SwimlaneChart({ samples, events, config, scaleTarget }: Props) {
  const { t } = useI18n();
  const plan = useMemo(
    () => buildTidePlan(samples, events, config, scaleTarget),
    [samples, events, config, scaleTarget],
  );

  if (!plan.drawable) {
    return <div className="tide tide--empty">{t("scaling.empty")}</div>;
  }

  return (
    <div className="tide">
      <div className="tide__svg-host">
        <svg
          className="tide__svg"
          viewBox={`0 0 ${TIDE_VIEW.width} ${TIDE_VIEW.height}`}
          preserveAspectRatio="none"
          role="img"
          aria-label={t("scaling.tide.legend.active")}
        >
          <defs>
            <linearGradient id="tide-active-fill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="rgba(79,193,255,0.55)" />
              <stop offset="100%" stopColor="rgba(79,193,255,0.04)" />
            </linearGradient>
            <linearGradient id="tide-ceiling-fill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="rgba(244,135,113,0.18)" />
              <stop offset="100%" stopColor="rgba(244,135,113,0)" />
            </linearGradient>
            <linearGradient id="tide-floor-fill" x1="0" y1="1" x2="0" y2="0">
              <stop offset="0%" stopColor="rgba(137,209,133,0.16)" />
              <stop offset="100%" stopColor="rgba(137,209,133,0)" />
            </linearGradient>
            <pattern
              id="tide-grid"
              width={Math.round((TIDE_VIEW.x1 - TIDE_VIEW.x0) / 8)}
              height={Math.round((TIDE_VIEW.y1 - TIDE_VIEW.y0) / 6)}
              patternUnits="userSpaceOnUse"
            >
              <path
                d={`M ${Math.round((TIDE_VIEW.x1 - TIDE_VIEW.x0) / 8)} 0 L 0 0 0 ${Math.round((TIDE_VIEW.y1 - TIDE_VIEW.y0) / 6)}`}
                fill="none"
                stroke="rgba(255,255,255,0.025)"
                strokeWidth={1}
              />
            </pattern>
          </defs>

          {/* Background grid */}
          <rect
            x={TIDE_VIEW.x0}
            y={TIDE_VIEW.y0}
            width={TIDE_VIEW.x1 - TIDE_VIEW.x0}
            height={TIDE_VIEW.y1 - TIDE_VIEW.y0}
            fill="url(#tide-grid)"
          />

          {/* Ceiling band + dashed line + label */}
          {plan.ceilingY != null && plan.ceiling != null && (
            <g>
              <rect
                x={TIDE_VIEW.x0}
                y={TIDE_VIEW.y0}
                width={TIDE_VIEW.x1 - TIDE_VIEW.x0}
                height={Math.max(0, plan.ceilingY - TIDE_VIEW.y0)}
                fill="url(#tide-ceiling-fill)"
              />
              <line
                x1={TIDE_VIEW.x0}
                x2={TIDE_VIEW.x1}
                y1={plan.ceilingY}
                y2={plan.ceilingY}
                stroke="var(--bad)"
                strokeDasharray="6 4"
                strokeWidth={1}
              />
              <text
                x={TIDE_VIEW.x1 - 5}
                y={plan.ceilingY - 6}
                textAnchor="end"
                fontFamily="var(--mono)"
                fontSize={10}
                fill="var(--bad)"
                opacity={0.85}
              >
                {t("scaling.tide.ceiling", { n: plan.ceiling })}
              </text>
            </g>
          )}

          {/* Floor band + dashed line + label */}
          {plan.floorY != null && plan.floor != null && (
            <g>
              <rect
                x={TIDE_VIEW.x0}
                y={plan.floorY}
                width={TIDE_VIEW.x1 - TIDE_VIEW.x0}
                height={Math.max(0, TIDE_VIEW.y1 - plan.floorY)}
                fill="url(#tide-floor-fill)"
              />
              <line
                x1={TIDE_VIEW.x0}
                x2={TIDE_VIEW.x1}
                y1={plan.floorY}
                y2={plan.floorY}
                stroke="var(--ok)"
                strokeDasharray="6 4"
                strokeWidth={1}
              />
              <text
                x={TIDE_VIEW.x1 - 5}
                y={plan.floorY - 4}
                textAnchor="end"
                fontFamily="var(--mono)"
                fontSize={10}
                fill="var(--ok)"
                opacity={0.85}
              >
                {t("scaling.tide.floor", { n: plan.floor })}
              </text>
            </g>
          )}

          {/* Y axis labels */}
          <g fontFamily="var(--mono)" fontSize={10} fill="var(--text-dim)">
            {plan.yTicks.map((tk) => (
              <text key={`yt-${tk.label}-${tk.y.toFixed(1)}`} x={TIDE_VIEW.x0 - 6} y={tk.y + 4} textAnchor="end">
                {tk.label}
              </text>
            ))}
          </g>

          {/* Active VMs area + top line */}
          <path d={plan.areaPath} fill="url(#tide-active-fill)" />
          <path d={plan.topLinePath} fill="none" stroke="var(--info)" strokeWidth={1.6} />

          {/* Target dashed line (scheduler intent) */}
          {plan.targetPath !== "" && (
            <path
              d={plan.targetPath}
              fill="none"
              stroke="var(--violet)"
              strokeWidth={1.4}
              strokeDasharray="4 3"
              opacity={0.85}
            />
          )}

          {/* Event markers */}
          {plan.events.map((m, idx) => (
            <EventGlyph key={`ev-${m.ts}-${idx}`} marker={m} />
          ))}

          {/* "now" cursor */}
          <line
            x1={plan.nowX}
            x2={plan.nowX}
            y1={TIDE_VIEW.y0}
            y2={TIDE_VIEW.y1}
            stroke="var(--info)"
            strokeWidth={1}
            opacity={0.8}
          />
          <circle cx={plan.nowX} cy={plan.nowY} r={4} fill="var(--info)" stroke="#fff" strokeWidth={1} />

          {/* X axis labels */}
          <g fontFamily="var(--mono)" fontSize={10} fill="var(--text-dim)">
            {plan.xTicks.map((tk) => (
              <text key={`xt-${tk.label}-${tk.x.toFixed(1)}`} x={tk.x} y={TIDE_VIEW.height - 4}>
                {tk.label}
              </text>
            ))}
            <text
              x={plan.nowX}
              y={TIDE_VIEW.height - 4}
              textAnchor="end"
              fontWeight={600}
              fill="var(--info)"
            >
              {t("scaling.tide.now")}
            </text>
          </g>
        </svg>
      </div>

      {!plan.hasConfig && (
        <div className="tide__notice">{t("scaling.tide.noConfig")}</div>
      )}

      <div className="tide__legend">
        {plan.hasConfig && (
          <span className="tide__legend-item">
            <span className="tide__swatch tide__swatch--ceiling" />
            {t("scaling.tide.legend.ceiling")}
          </span>
        )}
        {plan.hasConfig && (
          <span className="tide__legend-item">
            <span className="tide__swatch tide__swatch--floor" />
            {t("scaling.tide.legend.floor")}
          </span>
        )}
        <span className="tide__legend-item">
          <span className="tide__swatch tide__swatch--active" />
          {t("scaling.tide.legend.active")}
        </span>
        {plan.targetPath !== "" && (
          <span className="tide__legend-item">
            <span className="tide__swatch tide__swatch--target" />
            {t("scaling.tide.legend.target")}
          </span>
        )}
        <span className="tide__legend-item">
          <span className="tide__swatch tide__swatch--scale_up" />
          {t("scaling.tide.legend.scale_up")}
        </span>
        <span className="tide__legend-item">
          <span className="tide__swatch tide__swatch--eviction" />
          {t("scaling.tide.legend.eviction")}
        </span>
      </div>
    </div>
  );
}

function EventGlyph({ marker }: { marker: EventMarker }) {
  const { x, y, type } = marker;
  switch (type) {
    case "scale_up":
      return (
        <polygon
          points={`${x},${y - 14} ${x - 5},${y - 2} ${x + 5},${y - 2}`}
          fill="var(--ok)"
        />
      );
    case "scale_down":
      return (
        <polygon
          points={`${x - 5},${y + 2} ${x + 5},${y + 2} ${x},${y + 14}`}
          fill="var(--violet)"
        />
      );
    case "node_evicted":
      return <circle cx={x} cy={y} r={5} fill="var(--bad)" />;
    case "node_replaced":
      return (
        <polygon
          points={`${x},${y - 6} ${x + 6},${y} ${x},${y + 6} ${x - 6},${y}`}
          fill="var(--violet)"
          stroke="var(--text-strong)"
          strokeWidth={0.6}
        />
      );
    case "node_provisioned":
      return <circle cx={x} cy={y} r={4} fill="var(--info)" stroke="#fff" strokeWidth={0.5} />;
    default:
      return <circle cx={x} cy={y} r={3} fill="var(--text-muted)" />;
  }
}
