import { describe, expect, it } from "vitest";
import { buildReport } from "./report";
import type { AdAction, PeriodStats, Verdict } from "./types";
import type { PerfTotals } from "@/lib/performance";
import type { Targets } from "@/lib/metrics";
import { formatMoney } from "@/lib/format";

const totals = (o: Partial<PerfTotals> = {}): PerfTotals => ({
  spend: 0, impressions: 0, link_clicks: 0, landing_page_views: 0, add_to_cart: 0, purchases: 0, purchase_value: 0,
  sessions: 0, add_to_cart_sessions: 0, conversion_sessions: 0, tracked_value: 0, meta_leads: 0, signup_sessions: 0,
  trial_sessions: 0, demo_sessions: 0, lead_sessions: 0, paid_events: 0, leads: 0, signups: 0, trials: 0, demos: 0, paid: 0, reach: 0, frequency: null,
  rates: {}, ...o,
});
const ps = (spend: number, results: number): PeriodStats => ({
  spend, impressions: 5000, link_clicks: 100, results, frequency: null, ctr: 2, cost_per_result: results > 0 ? spend / results : null,
});
const ad = (id: string, verdict: Verdict, spend: number, results: number): AdAction => ({
  ad_id: id, name: `Ad ${id}`, thumbnail_url: null, campaign_id: null, adset_id: null, verdict, confidence: "medium",
  reasons: [], signals: { frequency: false, ctr_drop: false, cost_rise: false }, recent: ps(spend, results), previous: ps(0, 0), suggestion: "",
});
const windows = { recent: { from: "2026-11-14", to: "2026-11-20" }, previous: { from: "2026-11-07", to: "2026-11-13" } };
const base = { clientName: "Acme Clinic", type: "lead_gen" as const, currency: "INR", windows, recentTotals: totals(), previousTotals: totals(), actions: [] as AdAction[], targets: {} as Targets };

describe("buildReport target_checks", () => {
  it("lists the lead_gen metrics with status and type label", () => {
    const targets: Targets = { cpl: { min: null, max: 300 }, ctr: { min: 2, max: null } };
    const r = buildReport({ ...base, targets, recentTotals: totals({ spend: 1000, leads: 5, rates: { ctr: 3, cpc: 10, cpm: 50, cpl: 200, lead_rate: 4 } }) });
    expect(r.target_checks.map((c) => c.metric)).toEqual(["ctr", "cpc", "cpm", "cpl", "lead_rate"]);
    const by = Object.fromEntries(r.target_checks.map((c) => [c.metric, c]));
    expect(by.cpl.status).toBe("on_target");
    expect(by.cpl.value).toBe(200);
    expect(by.cpl.label).toBe("Cost per lead (CPL)");
    expect(by.ctr.status).toBe("on_target");
    expect(by.cpc.status).toBe("no_data"); // no target set
  });
  it("flags off_target and better", () => {
    const r = buildReport({ ...base, targets: { cpl: { min: null, max: 100 }, ctr: { min: 1, max: 2 } }, recentTotals: totals({ rates: { cpl: 200, ctr: 3 } }) });
    const by = Object.fromEntries(r.target_checks.map((c) => [c.metric, c.status]));
    expect(by.cpl).toBe("off_target");
    expect(by.ctr).toBe("better");
  });
  it("uses the saas label override and metrics", () => {
    const r = buildReport({ ...base, type: "saas_b2b" });
    expect(r.target_checks.map((c) => c.metric)).toEqual(["ctr", "cpc", "cpm", "cpl", "signup_rate", "demo_rate", "cost_per_trial", "cac"]);
    expect(r.target_checks.find((c) => c.metric === "cpl")!.label).toBe("Cost per signup (CPL)");
  });
  it("uses the ecommerce metrics", () => {
    const r = buildReport({ ...base, type: "ecommerce", targets: { roas: { min: 5, max: null } }, recentTotals: totals({ rates: { roas: 3 } }) });
    expect(r.target_checks.map((c) => c.metric)).toContain("roas");
    expect(r.target_checks.find((c) => c.metric === "roas")!.status).toBe("off_target");
  });
  it("gives null value and no_data with empty rates", () => {
    const r = buildReport(base);
    for (const c of r.target_checks) { expect(c.value).toBeNull(); expect(c.status).toBe("no_data"); }
  });
});

describe("buildReport period stats", () => {
  it("derives results per type and cost per result", () => {
    const lead = buildReport({ ...base, recentTotals: totals({ spend: 1000, leads: 4, impressions: 10000, link_clicks: 200 }) });
    expect(lead.recent).toMatchObject({ spend: 1000, results: 4, cost_per_result: 250, ctr: 2, impressions: 10000, link_clicks: 200 });
    const saas = buildReport({ ...base, type: "saas_b2b", recentTotals: totals({ spend: 90, signups: 3 }) });
    expect(saas.recent.results).toBe(3);
    const ecom = buildReport({ ...base, type: "ecommerce", recentTotals: totals({ spend: 100, purchases: 2 }) });
    expect(ecom.recent.results).toBe(2);
    expect(ecom.recent.cost_per_result).toBe(50);
  });
  it("uses null, never NaN, for empty data", () => {
    const r = buildReport(base);
    for (const p of [r.recent, r.previous]) {
      expect(p.cost_per_result).toBeNull();
      expect(p.ctr).toBeNull();
      expect(p.frequency).toBeNull();
      expect(p.results).toBe(0);
    }
    expect(JSON.stringify(r)).not.toMatch(/NaN|Infinity/);
  });
  it("passes through identity fields", () => {
    const r = buildReport(base);
    expect(r).toMatchObject({ currency: "INR", business_type: "lead_gen", client_name: "Acme Clinic", windows });
  });
});

describe("buildReport top and bottom ads", () => {
  const actions = [
    ad("a", "scale", 100, 10),   // 10
    ad("b", "keep_watch", 100, 5), // 20
    ad("c", "keep_watch", 100, 2), // 50
    ad("d", "refresh_creative", 100, 1), // 100
    ad("e", "pause", 300, 0),    // spend, no results
    ad("f", "too_early", 0, 0),  // no spend: ignored
  ];
  it("top 3 are cheapest with results; bottom 3 worst, no-result spenders first", () => {
    const r = buildReport({ ...base, actions });
    expect(r.top_ads.map((a) => a.ad_id)).toEqual(["a", "b", "c"]);
    expect(r.bottom_ads.map((a) => a.ad_id)).toEqual(["e", "d"]);
  });
  it("never lists the same ad as top and bottom", () => {
    const r = buildReport({ ...base, actions: [ad("a", "scale", 10, 5), ad("b", "keep_watch", 10, 1)] });
    expect(r.top_ads.map((a) => a.ad_id)).toEqual(["a", "b"]);
    expect(r.bottom_ads).toEqual([]);
  });
  it("is empty without ads", () => {
    const r = buildReport(base);
    expect(r.top_ads).toEqual([]);
    expect(r.bottom_ads).toEqual([]);
  });
  it("does not mutate the input array", () => {
    const copy = [...actions];
    buildReport({ ...base, actions });
    expect(actions.map((a) => a.ad_id)).toEqual(copy.map((a) => a.ad_id));
  });
});

describe("buildReport next_actions", () => {
  it("words actions from verdict counts", () => {
    const r = buildReport({ ...base, actions: [ad("1", "pause", 1, 0), ad("2", "pause", 1, 0), ad("3", "refresh_creative", 1, 1), ad("4", "scale", 1, 9), ad("5", "scale", 1, 9)] });
    expect(r.next_actions).toEqual(["Pause 2 ads", "Refresh creative on 1 ad", "Raise budget on 2 winners"]);
  });
  it("uses singular for one", () => {
    const r = buildReport({ ...base, actions: [ad("1", "pause", 1, 0), ad("4", "scale", 1, 9)] });
    expect(r.next_actions).toEqual(["Pause 1 ad", "Raise budget on 1 winner"]);
  });
  it("mentions too-early ads and falls back to a keep-going message", () => {
    expect(buildReport({ ...base, actions: [ad("1", "too_early", 1, 0)] }).next_actions).toEqual(["Wait for more data on 1 ad"]);
    expect(buildReport({ ...base, actions: [ad("1", "keep_watch", 1, 1)] }).next_actions).toEqual(["No changes needed. Keep watching results."]);
    expect(buildReport(base).next_actions).toEqual(["No changes needed. Keep watching results."]);
  });
});

describe("buildReport whatsapp_text", () => {
  const r = buildReport({
    ...base,
    recentTotals: totals({ spend: 12000, leads: 40, impressions: 10000, link_clicks: 200 }),
    previousTotals: totals({ spend: 10000, leads: 20 }),
    actions: [ad("1", "pause", 1, 0), ad("2", "scale", 1, 9)],
  });
  const t = r.whatsapp_text;
  it("has client, dates, formatted spend, results and cost per result", () => {
    expect(t).toContain("Acme Clinic");
    expect(t).toContain("2026-11-14");
    expect(t).toContain("2026-11-20");
    expect(t).toContain(formatMoney(12000, "INR"));
    expect(t).toContain(formatMoney(300, "INR"));
    expect(t).toMatch(/Results.*40/);
    expect(t).toContain("lead");
  });
  it("shows change vs previous", () => {
    expect(t).toContain("+100%"); // results 20 -> 40
    expect(t).toContain("+20%"); // spend 10000 -> 12000
    expect(t).toContain("-40%"); // cost per result 500 -> 300
  });
  it("lists top actions", () => {
    expect(t).toContain("Pause 1 ad");
    expect(t).toContain("Raise budget on 1 winner");
  });
  it("is plain text without markdown tables or emphasis", () => {
    expect(t).not.toMatch(/\|/);
    expect(t).not.toMatch(/\*\*|^#|`/m);
    expect(t).not.toMatch(/NaN|Infinity|undefined|null/);
  });
  it("copes with empty data", () => {
    const e = buildReport(base).whatsapp_text;
    expect(e).toContain("Acme Clinic");
    expect(e).toContain("no data");
    expect(e).not.toMatch(/NaN|Infinity|undefined|null/);
  });
});

describe("buildReport wording", () => {
  it("says no data (not no previous data) when the current value is missing", () => {
    const r = buildReport({ ...base, previousTotals: totals({ spend: 100, leads: 5 }), recentTotals: totals({ spend: 100, leads: 0 }) });
    expect(r.whatsapp_text).toMatch(/Cost per lead: .*\(no data\)/);
    expect(r.whatsapp_text).not.toMatch(/Cost per lead: .*no previous data/);
  });
  it("says no previous data when only the previous value is missing", () => {
    const r = buildReport({ ...base, previousTotals: totals(), recentTotals: totals({ spend: 100, leads: 5 }) });
    expect(r.whatsapp_text).toMatch(/no previous data/);
  });
  it("does not print spend when there is no ad account", () => {
    const r = buildReport({ ...base, adAccount: false });
    expect(r.whatsapp_text).toContain("No ad data yet");
    expect(r.whatsapp_text).not.toMatch(/Spend:/);
  });
});
