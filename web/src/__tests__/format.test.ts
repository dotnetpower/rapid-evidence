import { describe, expect, it } from "vitest";
import { formatDuration, formatNumber, formatPercent, formatRate } from "../lib/format";

describe("format helpers", () => {
  it("formats numbers with thousand separators", () => {
    expect(formatNumber(0)).toBe("0");
    expect(formatNumber(9684)).toBe("9,684");
    expect(formatNumber(null)).toBe("—");
    expect(formatNumber(undefined)).toBe("—");
  });

  it("formats rates with sensible precision", () => {
    expect(formatRate(0)).toBe("0.0 r/s");
    expect(formatRate(8.2)).toBe("8.2 r/s");
    expect(formatRate(82)).toBe("82 r/s");
    expect(formatRate(null)).toBe("—");
  });

  it("formats durations as human readable", () => {
    expect(formatDuration(0)).toBe("< 1s");
    expect(formatDuration(7)).toBe("7s");
    expect(formatDuration(75)).toBe("1m 15s");
    expect(formatDuration(3 * 60)).toBe("3m");
    expect(formatDuration(3600 + 600)).toBe("1h 10m");
    expect(formatDuration(null)).toBe("—");
  });

  it("formats percentages", () => {
    expect(formatPercent(0)).toBe("0.0%");
    expect(formatPercent(42)).toBe("42%");
    expect(formatPercent(99.4)).toBe("99%");
    expect(formatPercent(7.1)).toBe("7.1%");
    expect(formatPercent(null)).toBe("—");
  });
});
