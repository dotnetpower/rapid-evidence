export function formatNumber(value: number | null | undefined): string {
  if (value == null || Number.isNaN(value)) return "—";
  return value.toLocaleString("en-US");
}

export function formatRate(value: number | null | undefined, suffix = "r/s"): string {
  if (value == null || Number.isNaN(value)) return "—";
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${suffix}`;
}

export function formatDuration(seconds: number | null | undefined): string {
  if (seconds == null || Number.isNaN(seconds)) return "—";
  if (seconds < 1) return "< 1s";
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const total = Math.round(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0 && s > 0 && m < 10) return `${m}m ${s}s`;
  return `${m}m`;
}

export function formatPercent(value: number | null | undefined): string {
  if (value == null || Number.isNaN(value)) return "—";
  return `${value.toFixed(value >= 10 ? 0 : 1)}%`;
}

export function timeAgo(iso: string | null | undefined, nowMs: number = Date.now()): string {
  if (!iso) return "—";
  const ts = Date.parse(iso);
  if (Number.isNaN(ts)) return "—";
  const seconds = Math.max(0, Math.round((nowMs - ts) / 1000));
  return formatDuration(seconds) + " ago";
}

/**
 * Locale-aware "X ago" string. Examples:
 *   en: "9s ago", "2m ago", "1h 5m ago"
 *   ko: "9초 전", "2분 전", "1시간 5분 전"
 * Returns "—" for missing or unparseable input.
 */
export function timeAgoLocalized(
  iso: string | null | undefined,
  nowMs: number,
  lang: "en" | "ko",
): string {
  if (!iso) return "—";
  const ts = Date.parse(iso);
  if (Number.isNaN(ts)) return "—";
  const seconds = Math.max(0, Math.round((nowMs - ts) / 1000));
  if (lang !== "ko") return formatDuration(seconds) + " ago";
  // Korean form: "방금 / N초 전 / N분 / N시간 N분 전"
  if (seconds < 1) return "방금";
  if (seconds < 60) return `${seconds}초 전`;
  const total = Math.round(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  if (h > 0) {
    return m > 0 ? `${h}시간 ${m}분 전` : `${h}시간 전`;
  }
  return `${m}분 전`;
}
