/**
 * Sparkline — small inline area chart used inside KPI cards.
 *
 * Pure SVG, no recharts. Accepts a fixed-width pixel canvas so the
 * caller can pack many sparklines without layout flicker. Renders
 * area + last-point dot for "current" emphasis.
 *
 * Empty/short series degrades to a flat baseline. Single-value series
 * renders a centred dot — does not crash.
 */

export interface SparklineProps {
  /** Numeric series (oldest → newest). */
  values: ReadonlyArray<number>;
  /** Canvas width in pixels. */
  width?: number;
  /** Canvas height in pixels. */
  height?: number;
  /** Stroke / area color. Defaults to currentColor. */
  color?: string;
  /** Override the y-axis floor; default = min(values). */
  yMin?: number;
  /** Override the y-axis ceiling; default = max(values). */
  yMax?: number;
  /** Accessible label for screen readers. */
  ariaLabel?: string;
}

export function Sparkline({
  values,
  width = 120,
  height = 28,
  color = "currentColor",
  yMin,
  yMax,
  ariaLabel,
}: SparklineProps) {
  if (values.length === 0) {
    return (
      <svg
        className="sparkline"
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label={ariaLabel ?? "no data"}
      >
        <line
          x1={2}
          x2={width - 2}
          y1={height / 2}
          y2={height / 2}
          stroke={color}
          strokeOpacity={0.25}
          strokeDasharray="2 2"
        />
      </svg>
    );
  }

  // Reduce-based min/max so a `Math.min(...arr)` spread doesn't stack-overflow
  // on long series, and so NaN/Infinity entries are silently ignored instead
  // of poisoning the whole projection (which would produce NaN coords and
  // render an invisible chart).
  let computedMin = Number.POSITIVE_INFINITY;
  let computedMax = Number.NEGATIVE_INFINITY;
  for (const v of values) {
    if (!Number.isFinite(v)) continue;
    if (v < computedMin) computedMin = v;
    if (v > computedMax) computedMax = v;
  }
  if (!Number.isFinite(computedMin) || !Number.isFinite(computedMax)) {
    computedMin = 0;
    computedMax = 0;
  }
  const numericMin = yMin ?? computedMin;
  const numericMax = yMax ?? computedMax;
  const range = numericMax - numericMin || 1;
  const flat = numericMax === numericMin;
  const padX = 2;
  const padY = 2;
  const usableW = width - padX * 2;
  const usableH = height - padY * 2;

  const points = values.map((v, i) => {
    const safe = Number.isFinite(v) ? v : numericMin;
    const x =
      values.length === 1
        ? width / 2
        : padX + (i / (values.length - 1)) * usableW;
    // Flat series → render along the vertical midline so it doesn't
    // sit at the chart floor and look like a permanent "low".
    const y = flat
      ? padY + usableH / 2
      : padY + usableH - ((safe - numericMin) / range) * usableH;
    return [x, y] as const;
  });

  const linePath = points
    .map(([x, y], i) => `${i === 0 ? "M" : "L"}${x.toFixed(1)} ${y.toFixed(1)}`)
    .join(" ");
  const areaPath =
    linePath +
    ` L ${points[points.length - 1][0].toFixed(1)} ${height - padY}` +
    ` L ${points[0][0].toFixed(1)} ${height - padY} Z`;
  const [lastX, lastY] = points[points.length - 1];

  return (
    <svg
      className="sparkline"
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label={ariaLabel ?? `series of ${values.length} points`}
    >
      <path d={areaPath} fill={color} fillOpacity={0.18} />
      <path
        d={linePath}
        fill="none"
        stroke={color}
        strokeWidth={1.5}
        strokeLinejoin="round"
        strokeLinecap="round"
      />
      <circle cx={lastX} cy={lastY} r={2} fill={color} />
    </svg>
  );
}
