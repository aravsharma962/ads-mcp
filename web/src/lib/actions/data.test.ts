import { describe, expect, it } from "vitest";
import { eventBounds } from "./data";

describe("eventBounds", () => {
  const range = { from: "2026-11-01", to: "2026-11-07" };
  it("uses UTC days when no timezone is given", () => {
    expect(eventBounds(range)).toEqual({ gte: "2026-11-01T00:00:00.000Z", lte: "2026-11-07T23:59:59.999Z" });
  });
  it("covers the same calendar days in the client's timezone", () => {
    // Asia/Kolkata is UTC+5:30: local midnight Nov 1 = Oct 31 18:30Z; end of Nov 7 = Nov 7 18:29:59.999Z
    expect(eventBounds(range, "Asia/Kolkata")).toEqual({ gte: "2026-10-31T18:30:00.000Z", lte: "2026-11-07T18:29:59.999Z" });
    // America/New_York is UTC-5 in November (EST)
    expect(eventBounds({ from: "2026-11-02", to: "2026-11-07" }, "America/New_York")).toEqual({ gte: "2026-11-02T05:00:00.000Z", lte: "2026-11-08T04:59:59.999Z" });
  });
  it("handles a DST change inside the range", () => {
    // US DST ended 2026-11-01 02:00 local: Nov 1 starts at UTC-4, Nov 2 ends at UTC-5
    expect(eventBounds({ from: "2026-11-01", to: "2026-11-02" }, "America/New_York"))
      .toEqual({ gte: "2026-11-01T04:00:00.000Z", lte: "2026-11-03T04:59:59.999Z" });
  });
  it("falls back to UTC for an unknown timezone", () => {
    expect(eventBounds(range, "Not/AZone")).toEqual(eventBounds(range));
  });
});
