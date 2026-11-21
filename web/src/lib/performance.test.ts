import { describe, it, expect } from "vitest";
import { normalizeRow, normalizeUnattributed, sumRows } from "./performance";

const raw = (o: Record<string, unknown> = {}) => ({
  id: "c1", name: "Camp", spend: 100, impressions: 10000, link_clicks: 200, landing_page_views: 150,
  add_to_cart: 0, purchases: 0, purchase_value: 0, leads: 8, ...o,
});
const tracked = { signup_sessions: 10, trial_sessions: 5, demo_sessions: 4, lead_sessions: 20, paid_events: 2, sessions: 150 };

describe("normalizeRow by business type", () => {
  it("lead_gen without a site uses Meta leads", () => {
    const r = normalizeRow(raw(), { tracking: false, roasSource: "tracking", type: "lead_gen" });
    expect(r.leads).toBe(8);
    expect(r.rates.cpl).toBeCloseTo(12.5);
    expect(r.rates.lead_rate).toBeCloseTo(4);
    expect(Object.keys(r.rates).sort()).toEqual(["cpc", "cpl", "cpm", "ctr", "lead_rate"]);
  });
  it("lead_gen with a site uses tracked lead sessions, not Meta leads", () => {
    const r = normalizeRow(raw(tracked), { tracking: true, roasSource: "tracking", type: "lead_gen" });
    expect(r.leads).toBe(20);
    expect(r.rates.cpl).toBeCloseTo(5);
    expect(r.rates.lead_rate).toBeCloseTo(10);
  });
  it("saas_b2b with a site: signups, demos, trials and paid come from tracked events", () => {
    const r = normalizeRow(raw(tracked), { tracking: true, roasSource: "tracking", type: "saas_b2b" });
    expect(r.rates.cpl).toBeCloseTo(10);
    expect(r.rates.signup_rate).toBeCloseTo(5);
    expect(r.rates.demo_rate).toBeCloseTo(2);
    expect(r.rates.cost_per_trial).toBeCloseTo(20);
    expect(r.rates.cac).toBeCloseTo(50);
  });
  it("saas_b2b without a site: Meta leads stand in for signups; tracking-only metrics are null", () => {
    const r = normalizeRow(raw({ ...tracked, demo_sessions: 99, paid_events: 99 }), { tracking: false, roasSource: "tracking", type: "saas_b2b" });
    expect(r.rates.cpl).toBeCloseTo(12.5);
    expect(r.rates.signup_rate).toBeCloseTo(4);
    expect(r.rates.demo_rate).toBeNull();
    expect(r.rates.cost_per_trial).toBeNull();
    expect(r.rates.cac).toBeNull();
  });
  it("saas_b2b with a site but no paid events gives null cac, not Infinity", () => {
    const r = normalizeRow(raw({ ...tracked, paid_events: 0 }), { tracking: true, roasSource: "tracking", type: "saas_b2b" });
    expect(r.rates.cac).toBeNull();
  });
  it("ecommerce is unchanged by default (no type given)", () => {
    const r = normalizeRow(raw({ purchase_value: 900, sessions: 150 }), { tracking: false, roasSource: "tracking" });
    expect(r.rates.roas).toBeCloseTo(9);
    expect(r.rates.visit_rate).toBeNull();
    expect(r.rates.cpl).toBeUndefined();
  });
  it("garbage counts become 0, never NaN", () => {
    const r = normalizeRow(raw({ leads: "x", signup_sessions: NaN, paid_events: Infinity }), { tracking: true, roasSource: "tracking", type: "saas_b2b" });
    expect(r.meta_leads).toBe(0);
    expect(r.signup_sessions).toBe(0);
    expect(r.paid_events).toBe(0);
  });
});

describe("sumRows by business type", () => {
  it("recomputes saas rates from summed counts, not averages", () => {
    const s = { tracking: true, roasSource: "tracking", type: "saas_b2b" as const };
    const a = normalizeRow(raw({ id: "a", spend: 100, link_clicks: 100, signup_sessions: 10, paid_events: 1 }), s);
    const b = normalizeRow(raw({ id: "b", spend: 300, link_clicks: 300, signup_sessions: 10, paid_events: 0 }), s);
    const t = sumRows([a, b], s);
    expect(t.signups).toBe(20);
    expect(t.rates.cpl).toBeCloseTo(20);           // 400 / 20, not mean(10, 30)
    expect(t.rates.signup_rate).toBeCloseTo(5);    // 20 / 400
    expect(t.rates.cac).toBeCloseTo(400);          // 400 / 1
  });
  it("empty rows give null rates", () => {
    const t = sumRows([], { tracking: true, roasSource: "tracking", type: "lead_gen" });
    expect(t.rates.cpl).toBeNull();
    expect(t.rates.lead_rate).toBeNull();
  });
});

describe("normalizeUnattributed", () => {
  it("passes the business-type counts through", () => {
    const u = normalizeUnattributed({ sessions: 5, add_to_cart_sessions: 1, conversion_sessions: 2, signup_sessions: 3, trial_sessions: 1, demo_sessions: 0, lead_sessions: 2, paid_events: 1 });
    expect(u).toEqual({ sessions: 5, add_to_cart_sessions: 1, conversion_sessions: 2, signup_sessions: 3, trial_sessions: 1, demo_sessions: 0, lead_sessions: 2, paid_events: 1 });
    expect(normalizeUnattributed({ sessions: 1 })?.signup_sessions).toBe(0);
    expect(normalizeUnattributed(null)).toBeNull();
  });
});

describe("frequency and reach", () => {
  const s = { tracking: false, roasSource: "meta", type: "lead_gen" as const };
  it("normalizeRow parses reach and frequency", () => {
    const r = normalizeRow(raw({ reach: 5000, frequency: 2 }), s);
    expect(r.reach).toBe(5000);
    expect(r.frequency).toBe(2);
  });
  it("frequency is null when missing or 0, reach 0 when missing", () => {
    const a = normalizeRow(raw(), s);
    expect(a.frequency).toBeNull();
    expect(a.reach).toBe(0);
    expect(normalizeRow(raw({ frequency: 0, reach: 0 }), s).frequency).toBeNull();
    expect(normalizeRow(raw({ frequency: "x", reach: "y" }), s).frequency).toBeNull();
  });
  it("sumRows sums reach and recomputes frequency from impressions", () => {
    const rows = [normalizeRow(raw({ impressions: 1000, reach: 500 }), s), normalizeRow(raw({ impressions: 3000, reach: 1000 }), s)];
    const t = sumRows(rows, s);
    expect(t.reach).toBe(1500);
    expect(t.frequency).toBeCloseTo(4000 / 1500);
  });
  it("sumRows frequency is null when reach is 0", () => {
    expect(sumRows([normalizeRow(raw(), s)], s).frequency).toBeNull();
    expect(sumRows([], s).frequency).toBeNull();
  });
});
