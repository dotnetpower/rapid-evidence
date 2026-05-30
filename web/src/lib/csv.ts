/**
 * CSV export helper. Header + rows → triggers a browser download.
 *
 * - Quotes every cell defensively (handles commas, quotes, newlines).
 * - Prepends a UTF-8 BOM so Excel opens Korean / unicode cleanly.
 * - Cells that are null/undefined become empty.
 * - Caller is responsible for picking a sensible filename
 *   (`region-quota-2026-05-30.csv`).
 */

export type CsvCell = string | number | boolean | null | undefined;

/**
 * Characters that Excel / LibreOffice / Numbers interpret as a formula
 * when they appear at the *start* of a cell. Untrusted strings (e.g.
 * audit-event payloads) MUST be neutralised before export — see
 * CWE-1236 "Improper Neutralization of Formula Elements in a CSV File".
 *
 * Numeric / boolean cells we built ourselves never collide here, but
 * any user-supplied string (event payload, source name, error text)
 * may. We always sanitise string cells defensively.
 */
const FORMULA_TRIGGERS = /^[=+\-@\t\r]/;

function escapeCell(value: CsvCell): string {
  if (value == null) return "";
  let s = typeof value === "string" ? value : String(value);
  // CSV-injection: prepend a single quote so spreadsheets render the
  // literal text instead of evaluating it as a formula. The leading
  // quote is hidden in Excel and visible in Numbers, both safe.
  if (typeof value === "string" && FORMULA_TRIGGERS.test(s)) {
    s = "'" + s;
  }
  // RFC 4180: wrap if cell contains comma, quote, or newline.
  if (/[",\n\r]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

/**
 * Build CSV text from header + rows. Pure (no DOM access) — useful
 * for unit testing the format.
 */
export function buildCsv(headers: string[], rows: CsvCell[][]): string {
  const lines: string[] = [];
  lines.push(headers.map(escapeCell).join(","));
  for (const row of rows) {
    lines.push(row.map(escapeCell).join(","));
  }
  // CRLF per RFC 4180 (Windows tools like Excel prefer it).
  return lines.join("\r\n");
}

/**
 * Trigger a browser download for the given CSV. Wraps `buildCsv` and
 * cleans up the temporary object URL.
 */
export function downloadCsv(
  filename: string,
  headers: string[],
  rows: CsvCell[][],
): void {
  if (typeof document === "undefined") return;
  const csv = buildCsv(headers, rows);
  // BOM so Excel detects UTF-8 (Korean, glyphs).
  const blob = new Blob(["\uFEFF" + csv], {
    type: "text/csv;charset=utf-8",
  });
  const url = URL.createObjectURL(blob);
  try {
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.style.display = "none";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  } finally {
    // Defer revoke so Safari has time to start the download.
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}

/**
 * Build a date-stamped filename suffix (YYYYMMDD-HHmm).
 */
export function csvDateStamp(now: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    now.getFullYear().toString() +
    pad(now.getMonth() + 1) +
    pad(now.getDate()) +
    "-" +
    pad(now.getHours()) +
    pad(now.getMinutes())
  );
}
