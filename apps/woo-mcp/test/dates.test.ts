import { describe, expect, it } from "vitest";
import { dayRange, localDate, localIso, zoneOf } from "../src/dates.js";

describe("store-local dates", () => {
  // 20:00 UTC on Oct 10 is already Oct 11 in India (UTC+05:30).
  const t = new Date("2026-10-10T20:00:00Z");

  it("computes today in the store timezone, not UTC", () => {
    expect(localDate(t, "Asia/Kolkata")).toBe("2026-10-11");
    expect(localDate(t, "UTC")).toBe("2026-10-10");
  });

  it("formats now with the store offset", () => {
    expect(localIso(t, "Asia/Kolkata")).toBe("2026-10-11T01:30:00+05:30");
    expect(localIso(t, "UTC")).toBe("2026-10-10T20:00:00+00:00");
  });

  // WordPress date_query treats after/before as exclusive, so the bounds sit
  // just outside the day: orders at 00:00:00 and 23:59:59 are included (W2).
  it("covers a whole local day, including its first and last second", () => {
    expect(dayRange("2026-10-11")).toEqual({
      after: "2026-10-10T23:59:59",
      before: "2026-10-12T00:00:00",
    });
    expect(dayRange("2026-10-31").before).toBe("2026-11-01T00:00:00");
    expect(dayRange("2026-01-01").after).toBe("2025-12-31T23:59:59");
  });

  // WordPress stores a manual offset ("UTC+5:30") as timezone_string="" plus gmt_offset (W1).
  it("supports stores configured with a manual UTC offset", () => {
    expect(zoneOf("", 5.5)).toBe("UTC+05:30");
    expect(zoneOf("", -4)).toBe("UTC-04:00");
    expect(zoneOf("", 0)).toBe("UTC");
    expect(zoneOf("Asia/Kolkata", 5.5)).toBe("Asia/Kolkata");
    expect(localDate(t, "UTC+05:30")).toBe("2026-10-11");
    expect(localIso(t, "UTC+05:30")).toBe("2026-10-11T01:30:00+05:30");
    expect(localIso(t, "UTC-04:00")).toBe("2026-10-10T16:00:00-04:00");
  });
});
