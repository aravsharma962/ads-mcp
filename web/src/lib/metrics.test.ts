import { describe, it, expect } from "vitest";
import { statusFor, computeRates, DEFAULT_TARGETS, DIRECTION, type MetricKey } from "./metrics";

describe("statusFor", () => {
  const roasBand = { min: 9, max: 12 };
  it("higher-is-better metrics", () => {
    expect(statusFor("roas", 10, roasBand)).toBe("on_target");
    expect(statusFor("roas", 15, roasBand)).toBe("better");
    expect(statusFor("roas", 5, roasBand)).toBe("off_target");
  });
  it("lower-is-better metrics", () => {
    expect(statusFor("cpm", 10, { min: 13, max: 14 })).toBe("better");
    expect(statusFor("cpm", 20, { min: 13, max: 14 })).toBe("off_target");
    expect(statusFor("cpm", 13.5, { min: 13, max: 14 })).toBe("on_target");
    expect(statusFor("cpc", 20, { min: null, max: 20 })).toBe("on_target");
    expect(statusFor("cpc", 25, { min: null, max: 20 })).toBe("off_target");
    expect(statusFor("cpc", 5, { min: null, max: 20 })).toBe("on_target");
  });
  it("min-only higher-is-better band", () => {
    expect(statusFor("ctr", 3, { min: 3, max: null })).toBe("on_target");
    expect(statusFor("ctr", 2, { min: 3, max: null })).toBe("off_target");
    expect(statusFor("ctr", 8, { min: 3, max: null })).toBe("on_target");
  });
  it("no data for null, NaN, Infinity or empty band", () => {
    expect(statusFor("ctr", null, { min: 3, max: null })).toBe("no_data");
    expect(statusFor("ctr", NaN, { min: 3, max: null })).toBe("no_data");
    expect(statusFor("ctr", Infinity, { min: 3, max: null })).toBe("no_data");
    expect(statusFor("ctr", -Infinity, { min: 3, max: null })).toBe("no_data");
    expect(statusFor("ctr", 5, { min: null, max: null })).toBe("no_data");
  });
});

describe("computeRates", () => {
  const base = { spend: 100, impressions: 10000, linkClicks: 100, sessions: 80, addToCartSessions: 14, conversionSessions: 10, value: 900 };
  it("recomputes from sums", () => {
    const r = computeRates(base);
    expect(r.ctr).toBeCloseTo(1);
    expect(r.cpc).toBeCloseTo(1);
    expect(r.cpm).toBeCloseTo(10);
    expect(r.visit_rate).toBeCloseTo(80);
    expect(r.add_to_cart_rate).toBeCloseTo(14);
    expect(r.conversion_rate).toBeCloseTo(10);
    expect(r.roas).toBeCloseTo(9);
  });
  it("zero clicks gives null rates (never NaN/Infinity)", () => {
    const r = computeRates({ ...base, linkClicks: 0 });
    expect(r.ctr).toBeCloseTo(0);
    expect(r.cpc).toBeNull();
    expect(r.visit_rate).toBeNull();
    expect(r.add_to_cart_rate).toBeNull();
    expect(r.conversion_rate).toBeNull();
  });
  it("zero impressions and zero spend give null", () => {
    const r = computeRates({ ...base, impressions: 0, spend: 0 });
    expect(r.ctr).toBeNull();
    expect(r.cpm).toBeNull();
    expect(r.roas).toBeNull();
    for (const v of Object.values(r)) expect(v === null || Number.isFinite(v)).toBe(true);
  });
});

describe("defaults", () => {
  it("match the agreed defaults and cover all metrics with a direction", () => {
    expect(DEFAULT_TARGETS.ctr).toEqual({ min: 3, max: null });
    expect(DEFAULT_TARGETS.cpc).toEqual({ min: null, max: 20 });
    expect(DEFAULT_TARGETS.cpm).toEqual({ min: 13, max: 14 });
    expect(DEFAULT_TARGETS.add_to_cart_rate).toEqual({ min: 14, max: 16 });
    expect(DEFAULT_TARGETS.conversion_rate).toEqual({ min: 10, max: 12 });
    expect(DEFAULT_TARGETS.roas).toEqual({ min: 9, max: 12 });
    expect(DEFAULT_TARGETS.visit_rate).toEqual({ min: 80, max: null });
    for (const k of Object.keys(DEFAULT_TARGETS) as MetricKey[]) expect(DIRECTION[k]).toMatch(/higher|lower/);
    expect(DIRECTION.cpc).toBe("lower");
    expect(DIRECTION.cpm).toBe("lower");
  });
});
