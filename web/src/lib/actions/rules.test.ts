import { describe, it, expect } from "vitest";
import { parseActionRules } from "./rules";
import { DEFAULT_ACTION_RULES } from "./types";

describe("parseActionRules", () => {
  it("returns defaults for non-objects", () => {
    for (const bad of [null, undefined, "x", 5, [], true]) expect(parseActionRules(bad)).toEqual(DEFAULT_ACTION_RULES);
  });
  it("returns defaults for empty object", () => {
    expect(parseActionRules({})).toEqual(DEFAULT_ACTION_RULES);
  });
  it("keeps valid values", () => {
    const r = parseActionRules({ frequency_max: 4, ctr_drop_pct: 30, cost_rise_pct: 20, min_impressions: 2000, min_results_scale: 8, scale_better_pct: 25, window_days: 14, bounce_seconds: 5 });
    expect(r).toEqual({ frequency_max: 4, ctr_drop_pct: 30, cost_rise_pct: 20, min_impressions: 2000, min_results_scale: 8, scale_better_pct: 25, window_days: 14, bounce_seconds: 5 });
  });
  it("clamps to the allowed ranges", () => {
    const low = parseActionRules({ frequency_max: 0, ctr_drop_pct: 0, cost_rise_pct: -5, min_impressions: 1, min_results_scale: 0, scale_better_pct: 0, window_days: 1, bounce_seconds: 0 });
    expect(low).toEqual({ frequency_max: 1, ctr_drop_pct: 1, cost_rise_pct: 1, min_impressions: 100, min_results_scale: 1, scale_better_pct: 1, window_days: 3, bounce_seconds: 1 });
    const high = parseActionRules({ frequency_max: 99, ctr_drop_pct: 500, cost_rise_pct: 9999, min_impressions: 1e9, min_results_scale: 1e6, scale_better_pct: 200, window_days: 100, bounce_seconds: 600 });
    expect(high).toEqual({ frequency_max: 20, ctr_drop_pct: 90, cost_rise_pct: 500, min_impressions: 1e6, min_results_scale: 1000, scale_better_pct: 90, window_days: 30, bounce_seconds: 60 });
  });
  it("rounds window_days to an integer", () => {
    expect(parseActionRules({ window_days: 7.6 }).window_days).toBe(8);
  });
  it("falls back to the default per key for bad values", () => {
    const r = parseActionRules({ frequency_max: "abc", ctr_drop_pct: NaN, cost_rise_pct: Infinity, window_days: null, bounce_seconds: {}, min_impressions: 5000 });
    expect(r.frequency_max).toBe(3);
    expect(r.ctr_drop_pct).toBe(25);
    expect(r.cost_rise_pct).toBe(15);
    expect(r.window_days).toBe(7);
    expect(r.bounce_seconds).toBe(10);
    expect(r.min_impressions).toBe(5000);
  });
  it("ignores unknown keys", () => {
    expect(Object.keys(parseActionRules({ foo: 1 })).sort()).toEqual(Object.keys(DEFAULT_ACTION_RULES).sort());
  });
});
