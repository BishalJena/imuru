import { describe, expect, it } from "vitest";
import { dayRange, localDate, localIso } from "../src/dates.js";

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

  it("covers a whole local day", () => {
    expect(dayRange("2026-10-11")).toEqual({
      after: "2026-10-11T00:00:00",
      before: "2026-10-11T23:59:59",
    });
  });
});
