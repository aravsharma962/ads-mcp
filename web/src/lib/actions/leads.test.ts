import { describe, expect, it } from "vitest";
import { leadStats } from "./leads";
import type { LeadRow, LeadStatus } from "./types";

const lead = (i: number, status: LeadStatus, ad_id: string | null = "a1"): LeadRow => ({ session_id: `s${i}`, ts: "2026-11-01T00:00:00Z", ad_id, ad_name: null, url: null, status });

describe("leadStats", () => {
  it("counts total, qualified (qualified + won) and won, with costs", () => {
    const leads = [lead(1, "new"), lead(2, "qualified"), lead(3, "won"), lead(4, "lost"), lead(5, "new")];
    expect(leadStats(leads, 1000)).toEqual({ total: 5, attributed_total: 5, qualified: 2, won: 1, cost_per_lead: 200, cost_per_qualified_lead: 500 });
  });
  it("returns null costs with zero leads", () => {
    expect(leadStats([], 500)).toEqual({ total: 0, attributed_total: 0, qualified: 0, won: 0, cost_per_lead: null, cost_per_qualified_lead: null });
  });
  it("returns null cost per qualified lead when none qualified", () => {
    const r = leadStats([lead(1, "new"), lead(2, "lost")], 100);
    expect(r.cost_per_lead).toBe(50);
    expect(r.cost_per_qualified_lead).toBeNull();
  });
  it("handles zero or invalid spend without NaN", () => {
    expect(leadStats([lead(1, "won")], 0).cost_per_lead).toBe(0);
    const r = leadStats([lead(1, "won")], NaN);
    expect(r.cost_per_lead).toBeNull();
    expect(r.cost_per_qualified_lead).toBeNull();
  });
  it("computes costs from ad-attributed leads only, keeping total as all leads", () => {
    const leads = [lead(1, "new", "a1"), lead(2, "qualified", "a2"), lead(3, "won", null), lead(4, "qualified", null)];
    const r = leadStats(leads, 100);
    expect(r.total).toBe(4);
    expect(r.attributed_total).toBe(2);
    expect(r.cost_per_lead).toBe(50);
    expect(r.cost_per_qualified_lead).toBe(100); // only the attributed qualified lead
  });
  it("has null costs when all leads are organic", () => {
    const r = leadStats([lead(1, "won", null)], 100);
    expect(r.cost_per_lead).toBeNull();
    expect(r.cost_per_qualified_lead).toBeNull();
  });
});
