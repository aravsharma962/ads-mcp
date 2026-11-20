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

import {
  BUSINESS_TYPES, defaultTargetsFor, hasBand, metricDefinition, metricLabel, metricsForType, normalizeBusinessType,
  TRACKING_ONLY_METRICS, ALL_METRIC_KEYS,
} from "./metrics";
import { formatMetric } from "./format";

describe("business types", () => {
  it("each type has its own metric set; ecommerce is unchanged", () => {
    expect(metricsForType("ecommerce")).toEqual(["ctr", "cpc", "cpm", "visit_rate", "add_to_cart_rate", "conversion_rate", "roas"]);
    expect(metricsForType("lead_gen")).toEqual(["ctr", "cpc", "cpm", "cpl", "lead_rate"]);
    expect(metricsForType("saas_b2b")).toEqual(["ctr", "cpc", "cpm", "cpl", "signup_rate", "demo_rate", "cost_per_trial", "cac"]);
    expect([...BUSINESS_TYPES].sort()).toEqual(["ecommerce", "lead_gen", "saas_b2b"]);
    for (const t of BUSINESS_TYPES) for (const k of metricsForType(t)) expect(ALL_METRIC_KEYS).toContain(k);
  });
  it("normalizeBusinessType falls back to ecommerce for anything unknown", () => {
    expect(normalizeBusinessType("lead_gen")).toBe("lead_gen");
    expect(normalizeBusinessType("saas_b2b")).toBe("saas_b2b");
    for (const v of [undefined, null, "", "retail", 5, {}]) expect(normalizeBusinessType(v)).toBe("ecommerce");
  });
  it("directions: costs are lower-is-better, rates higher-is-better", () => {
    for (const k of ["cpl", "cost_per_trial", "cac"] as const) expect(DIRECTION[k]).toBe("lower");
    for (const k of ["lead_rate", "signup_rate", "demo_rate"] as const) expect(DIRECTION[k]).toBe("higher");
    expect(statusFor("cpl", 50, { min: null, max: 100 })).toBe("on_target");
    expect(statusFor("cpl", 150, { min: null, max: 100 })).toBe("off_target");
    expect(statusFor("cac", 10, { min: 20, max: 100 })).toBe("better");
    expect(statusFor("signup_rate", 1, { min: 2, max: null })).toBe("off_target");
  });
  it("new metrics start with empty targets; ecommerce defaults are untouched; empty band is no_data, never off target", () => {
    for (const t of ["lead_gen", "saas_b2b"] as const) {
      for (const k of metricsForType(t)) {
        if (["ctr", "cpc", "cpm"].includes(k)) continue;
        expect(defaultTargetsFor(t)[k]).toEqual({ min: null, max: null });
        expect(statusFor(k, 12, { min: null, max: null })).toBe("no_data");
      }
    }
    const eco = defaultTargetsFor("ecommerce");
    expect(Object.keys(eco).sort()).toEqual([...metricsForType("ecommerce")].sort());
    expect(eco.roas).toEqual({ min: 9, max: 12 });
    expect(hasBand({ min: null, max: null })).toBe(false);
    expect(hasBand({ min: 1, max: null })).toBe(true);
  });
  it("defaults for the shared network metrics follow the existing defaults in every type", () => {
    for (const t of BUSINESS_TYPES) expect(defaultTargetsFor(t).ctr).toEqual(DEFAULT_TARGETS.ctr);
  });
  it("tracking-only metrics per type", () => {
    expect(TRACKING_ONLY_METRICS.ecommerce).toEqual(["visit_rate", "add_to_cart_rate", "conversion_rate"]);
    expect(TRACKING_ONLY_METRICS.lead_gen).toEqual([]);
    expect(TRACKING_ONLY_METRICS.saas_b2b).toEqual(["demo_rate", "cost_per_trial", "cac"]);
  });
  it("cpl label and definition depend on the type", () => {
    expect(metricLabel("lead_gen", "cpl")).toMatch(/lead/i);
    expect(metricLabel("saas_b2b", "cpl")).toMatch(/signup/i);
    expect(metricDefinition("lead_gen", "cpl")).toMatch(/leads/);
    expect(metricDefinition("saas_b2b", "cpl")).toMatch(/signups/);
  });
});

describe("computeRates by type", () => {
  const base = { spend: 100, impressions: 10000, linkClicks: 200, sessions: 0, addToCartSessions: 0, conversionSessions: 0, value: 0 };
  it("lead_gen: cpl and lead_rate from totals, only lead_gen keys", () => {
    const r = computeRates({ ...base, leads: 20 }, "lead_gen");
    expect(Object.keys(r).sort()).toEqual([...metricsForType("lead_gen")].sort());
    expect(r.cpl).toBeCloseTo(5);
    expect(r.lead_rate).toBeCloseTo(10);
    expect(r.ctr).toBeCloseTo(2);
  });
  it("lead_gen: zero leads or zero clicks give null, never NaN/Infinity", () => {
    const r = computeRates({ ...base, leads: 0 }, "lead_gen");
    expect(r.cpl).toBeNull();
    expect(r.lead_rate).toBeCloseTo(0);
    const z = computeRates({ ...base, leads: 5, linkClicks: 0, impressions: 0, spend: 0 }, "lead_gen");
    for (const v of Object.values(z)) expect(v === null || Number.isFinite(v)).toBe(true);
    expect(z.lead_rate).toBeNull();
    expect(computeRates(base, "lead_gen").cpl).toBeNull();           // leads missing entirely
  });
  it("saas_b2b: every metric from the right denominator", () => {
    const r = computeRates({ ...base, signups: 10, demos: 4, trials: 5, paidEvents: 2 }, "saas_b2b");
    expect(Object.keys(r).sort()).toEqual([...metricsForType("saas_b2b")].sort());
    expect(r.cpl).toBeCloseTo(10);
    expect(r.signup_rate).toBeCloseTo(5);
    expect(r.demo_rate).toBeCloseTo(2);
    expect(r.cost_per_trial).toBeCloseTo(20);
    expect(r.cac).toBeCloseTo(50);
  });
  it("saas_b2b: each zero denominator gives null independently", () => {
    const r = computeRates({ ...base, signups: 0, demos: 0, trials: 0, paidEvents: 0 }, "saas_b2b");
    expect(r.cpl).toBeNull();
    expect(r.cost_per_trial).toBeNull();
    expect(r.cac).toBeNull();
    expect(r.signup_rate).toBeCloseTo(0);
    expect(r.demo_rate).toBeCloseTo(0);
    const z = computeRates({ ...base, linkClicks: 0, signups: 3, demos: 3, trials: 3, paidEvents: 3, spend: 0, impressions: 0 }, "saas_b2b");
    expect(z.signup_rate).toBeNull();
    expect(z.demo_rate).toBeNull();
    for (const v of Object.values(z)) expect(v === null || Number.isFinite(v)).toBe(true);
    // zero spend with real counts: cost metrics are 0, not null/NaN
    expect(z.cac).toBeCloseTo(0);
  });
  it("ecommerce stays the default and returns only its keys", () => {
    const r = computeRates({ ...base, sessions: 80, value: 900 });
    expect(Object.keys(r).sort()).toEqual([...metricsForType("ecommerce")].sort());
    expect(r.roas).toBeCloseTo(9);
  });
});

describe("formatMetric for new metrics", () => {
  it("costs are currency, rates are percent, null is no data", () => {
    expect(formatMetric("cpl", 12.5, "INR")).toMatch(/12\.50/);
    expect(formatMetric("cpl", 12.5, "INR")).toMatch(/₹|INR/);
    expect(formatMetric("cac", 500, "USD")).toBe("$500.00");
    expect(formatMetric("cost_per_trial", 20, "USD")).toBe("$20.00");
    expect(formatMetric("lead_rate", 10, "USD")).toBe("10.00%");
    expect(formatMetric("signup_rate", 5, "USD")).toBe("5.00%");
    expect(formatMetric("demo_rate", 2, "USD")).toBe("2.00%");
    for (const k of ALL_METRIC_KEYS) {
      expect(formatMetric(k, null, "USD")).toBe("no data");
      expect(formatMetric(k, undefined, "USD")).toBe("no data");
      expect(formatMetric(k, NaN, "USD")).toBe("no data");
    }
  });
});
