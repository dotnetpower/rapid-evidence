/**
 * CSV escape & build tests.
 *
 * Covers the CSV-injection fix from the cycle-2 hardening review:
 * any string cell starting with =, +, -, @, tab, or CR MUST be
 * prefixed with `'` so spreadsheets render it as literal text
 * (CWE-1236). Numeric cells we built ourselves stay untouched.
 */
import { describe, expect, it } from "vitest";
import { buildCsv } from "../lib/csv";

describe("buildCsv — RFC 4180 escaping", () => {
  it("quotes cells with commas, quotes, and newlines", () => {
    const out = buildCsv(["a", "b", "c"], [["x,y", 'he said "hi"', "line\nbreak"]]);
    expect(out).toContain('"x,y"');
    expect(out).toContain('"he said ""hi"""');
    expect(out).toContain('"line\nbreak"');
  });

  it("emits CRLF line breaks", () => {
    const out = buildCsv(["a"], [["1"], ["2"]]);
    expect(out.split("\r\n")).toEqual(["a", "1", "2"]);
  });

  it("treats null and undefined as empty cells", () => {
    const out = buildCsv(["a", "b"], [[null, undefined]]);
    expect(out.split("\r\n")[1]).toBe(",");
  });
});

describe("buildCsv — CSV-injection sanitisation (CWE-1236)", () => {
  for (const lead of ["=", "+", "-", "@", "\t", "\r"]) {
    it(`prefixes string cells starting with ${JSON.stringify(lead)} with a single quote`, () => {
      const payload = `${lead}cmd|'/c calc'!A1`;
      const out = buildCsv(["payload"], [[payload]]);
      const row = out.split("\r\n")[1];
      // The cell must start with `'` (or `"'` if RFC-quoted).
      // Strip the optional surrounding quotes for the check.
      const unquoted = row.startsWith('"') ? row.slice(1, -1).replace(/""/g, '"') : row;
      expect(unquoted.startsWith("'")).toBe(true);
      expect(unquoted.startsWith(`'${lead}`)).toBe(true);
    });
  }

  it("leaves benign string cells untouched", () => {
    const out = buildCsv(["region"], [["eastus2"]]);
    expect(out).toBe("region\r\neastus2");
  });

  it("never injects a quote into numeric cells", () => {
    // Negative numbers must NOT be misread as a formula trigger
    // because they're not strings — escapeCell only sanitises strings.
    const out = buildCsv(["headroom"], [[-5]]);
    expect(out).toBe("headroom\r\n-5");
  });

  it("preserves the original payload after sanitisation", () => {
    const out = buildCsv(["x"], [["=SUM(A1:A2)"]]);
    // Round-trip: the literal text is preserved, just neutralised.
    expect(out).toContain("'=SUM(A1:A2)");
  });
});
