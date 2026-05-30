import { describe, expect, it } from "vitest";
import {
  formatDuration,
  formatNumber,
  formatPercent,
  formatRate,
  timeAgoLocalized,
} from "../lib/format";

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

  describe("timeAgoLocalized", () => {
    const now = Date.parse("2026-05-30T08:00:00Z");
    const isoBefore = (sec: number) => new Date(now - sec * 1000).toISOString();

    it("returns em dash for missing or invalid input", () => {
      expect(timeAgoLocalized(null, now, "en")).toBe("—");
      expect(timeAgoLocalized(undefined, now, "ko")).toBe("—");
      expect(timeAgoLocalized("not-a-date", now, "ko")).toBe("—");
    });

    it("uses English 'ago' suffix for en", () => {
      expect(timeAgoLocalized(isoBefore(0), now, "en")).toBe("< 1s ago");
      expect(timeAgoLocalized(isoBefore(7), now, "en")).toBe("7s ago");
      expect(timeAgoLocalized(isoBefore(75), now, "en")).toBe("1m 15s ago");
      expect(timeAgoLocalized(isoBefore(3700), now, "en")).toBe("1h 1m ago");
    });

    it("uses Korean phrasing for ko", () => {
      expect(timeAgoLocalized(isoBefore(0), now, "ko")).toBe("방금");
      expect(timeAgoLocalized(isoBefore(9), now, "ko")).toBe("9초 전");
      expect(timeAgoLocalized(isoBefore(120), now, "ko")).toBe("2분 전");
      expect(timeAgoLocalized(isoBefore(75), now, "ko")).toBe("1분 전");
      expect(timeAgoLocalized(isoBefore(3600), now, "ko")).toBe("1시간 전");
      expect(timeAgoLocalized(isoBefore(3700), now, "ko")).toBe("1시간 1분 전");
    });

    it("clamps negative diffs (future timestamp) to zero", () => {
      const futureIso = new Date(now + 5_000).toISOString();
      expect(timeAgoLocalized(futureIso, now, "ko")).toBe("방금");
      expect(timeAgoLocalized(futureIso, now, "en")).toBe("< 1s ago");
    });
  });
});
