import { describe, it, expect } from "vitest";
import { computeActions, pickWinners, resultCount, resultLabel } from "./verdicts";
import { DEFAULT_ACTION_RULES, type ActionRules, type AdAction } from "./types";
import { normalizeRow, type PerfRow } from "../performance";
import type { BusinessType, Targets } from "../metrics";

const rules: ActionRules = { ...DEFAULT_ACTION_RULES, min_impressions: 1000, min_results_scale: 5 };

function row(o: Record<string, unknown> = {}, type: BusinessType = "lead_gen"): PerfRow {
  return normalizeRow({ id: "a1", ad_id: "a1", name: "Ad 1", spend: 1000, impressions: 20000, link_clicks: 340, leads: 20, purchases: 20, frequency: 1.5, reach: 13000, ...o }, { tracking: false, roasSource: "meta", type });
}
const run = (recent: PerfRow[], previous: PerfRow[], over: { type?: BusinessType; targets?: Targets; rules?: ActionRules } = {}) =>
  computeActions({ type: over.type ?? "lead_gen", recent, previous, rules: over.rules ?? rules, targets: over.targets ?? {}, currency: "INR" });

// previous: ctr 1.7%, cost per lead 50
const prev = () => row({ spend: 1000, impressions: 20000, link_clicks: 340, leads: 20, frequency: 1.5 });

describe("resultCount / resultLabel", () => {
  it("uses the business result per type", () => {
    const r = row({ leads: 7, purchases: 3 });
    expect(resultCount(r, "lead_gen")).toBe(7);
    expect(resultCount(r, "ecommerce")).toBe(3);
    expect(resultCount(normalizeRow({ id: "x", leads: 9 }, { tracking: false, roasSource: "meta", type: "saas_b2b" }), "saas_b2b")).toBe(9);
    expect(resultLabel("ecommerce")).toBe("purchase");
    expect(resultLabel("lead_gen")).toBe("lead");
    expect(resultLabel("saas_b2b")).toBe("signup");
  });
});

describe("computeActions verdicts", () => {
  it("pause when all three signals fire", () => {
    const recent = row({ spend: 1000, impressions: 20000, link_clicks: 240, leads: 12, frequency: 3.4 }); // ctr 1.2 (-29%), cpl 83 (+67%)
    const [a] = run([recent], [prev()]);
    expect(a.verdict).toBe("pause");
    expect(a.signals).toEqual({ frequency: true, ctr_drop: true, cost_rise: true });
    expect(a.reasons.join(" ")).toContain("Frequency 3.4 (limit 3)");
    expect(a.reasons.join(" ")).toMatch(/CTR fell 29% \(1\.2% vs 1\.7%\)/);
    expect(a.reasons.length).toBe(3);
  });
  it("refresh_creative with two signals", () => {
    const recent = row({ link_clicks: 240, leads: 20, frequency: 3.4 }); // freq + ctr drop, cost same
    const [a] = run([recent], [prev()]);
    expect(a.verdict).toBe("refresh_creative");
    expect(a.signals).toEqual({ frequency: true, ctr_drop: true, cost_rise: false });
  });
  it("keep_watch with one signal", () => {
    const [a] = run([row({ frequency: 3 })], [prev()]);
    expect(a.verdict).toBe("keep_watch");
    expect(a.signals.frequency).toBe(true);
    expect(a.reasons[0]).toContain("Frequency 3.0 (limit 3)");
  });
  it("too_early below min_impressions", () => {
    const [a] = run([row({ impressions: 500, link_clicks: 5, leads: 0, frequency: 5 })], [prev()]);
    expect(a.verdict).toBe("too_early");
    expect(a.confidence).toBe("low");
    expect(a.reasons[0]).toContain("500");
  });
  it("scale when target met", () => {
    const targets: Targets = { cpl: { min: null, max: 60 } };
    const [a] = run([row({ spend: 1000, leads: 20 })], [prev()], { targets }); // cpl 50 <= 60
    expect(a.verdict).toBe("scale");
    expect(a.suggestion).toBe("Raise the budget by at most 20%, then wait 3 days before the next change.");
    expect(a.reasons.join(" ")).toContain("60");
  });
  it("keep_watch when a target exists but is missed (even if cheaper than average)", () => {
    const targets: Targets = { cpl: { min: null, max: 40 } };
    const good = row({ id: "g", ad_id: "g", spend: 1000, leads: 20 });
    const bad = row({ id: "b", ad_id: "b", spend: 1000, leads: 5 });
    const res = run([good, bad], [prev()], { targets });
    expect(res.find((r) => r.ad_id === "g")!.verdict).toBe("keep_watch");
  });
  it("scale vs account average when there is no target", () => {
    const good = row({ id: "g", ad_id: "g", spend: 1000, leads: 20 }); // cpl 50
    const bad = row({ id: "b", ad_id: "b", spend: 1000, leads: 10 }); // cpl 100; avg 66.7
    const res = run([good, bad], []);
    expect(res.find((r) => r.ad_id === "g")!.verdict).toBe("scale");
    expect(res.find((r) => r.ad_id === "b")!.verdict).toBe("keep_watch");
  });
  it("no scale when results below min_results_scale", () => {
    const [a] = run([row({ spend: 100, leads: 4 })], [], { targets: { cpl: { min: null, max: 60 } } });
    expect(a.verdict).toBe("keep_watch");
  });
  it("ecommerce uses roas target when purchase_value > 0", () => {
    const r = row({ spend: 1000, purchases: 10, purchase_value: 10000 }, "ecommerce"); // roas 10
    const [a] = run([r], [], { type: "ecommerce", targets: { roas: { min: 9, max: 12 } } });
    expect(a.verdict).toBe("scale");
    const [b] = run([r], [], { type: "ecommerce", targets: { roas: { min: 11, max: null } } });
    expect(b.verdict).toBe("keep_watch");
  });
  it("ecommerce with a roas target but no roas data does not scale and skips the account-average test", () => {
    const good = row({ id: "g", ad_id: "g", spend: 500, purchases: 10, purchase_value: 0 }, "ecommerce");
    const bad = row({ id: "b", ad_id: "b", spend: 1500, purchases: 10, purchase_value: 0 }, "ecommerce");
    const res = run([good, bad], [], { type: "ecommerce", targets: { roas: { min: 9, max: 12 } } });
    expect(res.find((r) => r.ad_id === "g")!.verdict).toBe("keep_watch");
  });
  it("ecommerce without a roas target still compares with the account average", () => {
    const good = row({ id: "g", ad_id: "g", spend: 500, purchases: 10, purchase_value: 0 }, "ecommerce");
    const bad = row({ id: "b", ad_id: "b", spend: 1500, purchases: 10, purchase_value: 0 }, "ecommerce");
    const res = run([good, bad], [], { type: "ecommerce", targets: {} });
    expect(res.find((r) => r.ad_id === "g")!.verdict).toBe("scale");
  });
  it("ecommerce roas target uses the effective roas (tracking source), not purchase_value / spend", () => {
    const raw = { id: "a1", ad_id: "a1", name: "Ad 1", spend: 1000, impressions: 20000, link_clicks: 340, purchases: 10, purchase_value: 2000, tracked_value: 10000, frequency: 1.5, reach: 13000 };
    const r = normalizeRow(raw, { tracking: true, roasSource: "tracking", type: "ecommerce" }); // effective roas 10, meta roas 2
    expect(r.rates.roas).toBe(10);
    const [a] = run([r], [], { type: "ecommerce", targets: { roas: { min: 9, max: 12 } } });
    expect(a.verdict).toBe("scale");
    expect(a.reasons.join(" ")).toContain("ROAS 10.0x");
  });
});

describe("previous window handling", () => {
  it("empty previous does not create ctr_drop or cost_rise", () => {
    const [a] = run([row({ link_clicks: 50, leads: 2 })], []);
    expect(a.signals.ctr_drop).toBe(false);
    expect(a.signals.cost_rise).toBe(false);
    expect(a.previous).toEqual({ spend: 0, impressions: 0, link_clicks: 0, results: 0, frequency: null, ctr: null, cost_per_result: null });
  });
  it("previous below min_impressions gives no ctr_drop", () => {
    const p = row({ impressions: 200, link_clicks: 20, leads: 2, spend: 100 });
    const [a] = run([row({ link_clicks: 50 })], [p]);
    expect(a.signals.ctr_drop).toBe(false);
  });
  it("previous with zero results gives no cost_rise even when recent has none", () => {
    const p = row({ leads: 0 });
    const [a] = run([row({ leads: 0 })], [p]);
    expect(a.signals.cost_rise).toBe(false);
  });
  it("results 0 after results before is a cost rise", () => {
    const [a] = run([row({ leads: 0, spend: 800 })], [prev()]);
    expect(a.signals.cost_rise).toBe(true);
    expect(a.recent.cost_per_result).toBeNull();
    expect(a.reasons.join(" ")).toMatch(/No leads/);
  });
  it("zero recent results does not fire cost_rise when spend is below the previous cost per result", () => {
    const p = row({ spend: 40, leads: 1 }); // previous cost per result 40
    const [a] = run([row({ leads: 0, spend: 3 })], [p]);
    expect(a.signals.cost_rise).toBe(false);
  });
  it("zero recent results fires cost_rise once spend reaches the previous cost per result", () => {
    const p = row({ spend: 40, leads: 1 });
    const [a] = run([row({ leads: 0, spend: 40 })], [p]);
    expect(a.signals.cost_rise).toBe(true);
  });
  it("cost rise exactly at the limit is not a signal, above it is", () => {
    const at = row({ spend: 1150, leads: 20 }); // +15%
    expect(run([at], [prev()])[0].signals.cost_rise).toBe(false);
    const over = row({ spend: 1200, leads: 20 }); // +20%
    expect(run([over], [prev()])[0].signals.cost_rise).toBe(true);
    expect(run([over], [prev()])[0].reasons.join(" ")).toContain("rose 20%");
  });
  it("matches previous by id when ad_id is missing", () => {
    const r = row({ id: "z", ad_id: null, link_clicks: 240 });
    const p = row({ id: "z", ad_id: null });
    const [a] = run([r], [p]);
    expect(a.ad_id).toBe("z");
    expect(a.signals.ctr_drop).toBe(true);
  });
});

describe("zero-safe", () => {
  it("zero impressions, clicks and reach never produce NaN", () => {
    const z = row({ impressions: 0, link_clicks: 0, spend: 0, leads: 0, reach: 0, frequency: 0 });
    const [a] = run([z], [z]);
    expect(a.verdict).toBe("too_early");
    expect(a.recent.ctr).toBeNull();
    expect(a.recent.frequency).toBeNull();
    expect(a.recent.cost_per_result).toBeNull();
    expect(JSON.stringify(a)).not.toMatch(/NaN|Infinity|null.*undefined/);
  });
  it("zero clicks with enough impressions", () => {
    const [a] = run([row({ link_clicks: 0, leads: 0, spend: 10 })], [prev()]);
    expect(a.recent.ctr).toBe(0);
    expect(a.signals.ctr_drop).toBe(true);
  });
  it("no recent rows gives empty list", () => {
    expect(run([], [prev()])).toEqual([]);
  });
});

describe("confidence", () => {
  it("high, medium, low", () => {
    const hi = run([row({ impressions: 10000, leads: 10 })], [])[0];
    const med = run([row({ impressions: 3000, link_clicks: 50, leads: 3 })], [])[0];
    const lowImp = run([row({ impressions: 2999, link_clicks: 50, leads: 3 })], [])[0];
    const lowRes = run([row({ impressions: 50000, leads: 2 })], [])[0];
    expect(hi.confidence).toBe("high");
    expect(med.confidence).toBe("medium");
    expect(lowImp.confidence).toBe("low");
    expect(lowRes.confidence).toBe("low");
  });
});

describe("ordering and winners", () => {
  it("worst verdict first, then spend desc", () => {
    const paused = row({ id: "p", ad_id: "p", spend: 100, link_clicks: 240, leads: 1, frequency: 4 });
    const watchBig = row({ id: "w1", ad_id: "w1", spend: 900, leads: 3, frequency: 3.5 });
    const watchSmall = row({ id: "w2", ad_id: "w2", spend: 200, leads: 3, frequency: 3.5 });
    const early = row({ id: "e", ad_id: "e", impressions: 10, link_clicks: 0, leads: 0 });
    const res = run([early, watchSmall, watchBig, paused], [prev(), { ...prev(), id: "p", ad_id: "p" }, { ...prev(), id: "w1", ad_id: "w1" }, { ...prev(), id: "w2", ad_id: "w2" }]);
    expect(res.map((r) => r.ad_id)).toEqual(["p", "w1", "w2", "e"]);
  });
  it("pickWinners keeps scale only, cheapest first, limited", () => {
    const mk = (id: string, verdict: AdAction["verdict"], cpr: number | null): AdAction => ({
      ad_id: id, name: id, thumbnail_url: null, campaign_id: null, adset_id: null, verdict, confidence: "high", reasons: [],
      signals: { frequency: false, ctr_drop: false, cost_rise: false }, suggestion: "",
      recent: { spend: 1, impressions: 1, link_clicks: 1, results: 1, frequency: null, ctr: null, cost_per_result: cpr },
      previous: { spend: 0, impressions: 0, link_clicks: 0, results: 0, frequency: null, ctr: null, cost_per_result: null },
    });
    const list = [mk("a", "scale", 30), mk("b", "pause", 5), mk("c", "scale", 10), mk("d", "scale", null), mk("e", "scale", 20)];
    expect(pickWinners(list).map((x) => x.ad_id)).toEqual(["c", "e", "a", "d"]);
    expect(pickWinners(list, 2).map((x) => x.ad_id)).toEqual(["c", "e"]);
    expect(pickWinners([])).toEqual([]);
  });
});
