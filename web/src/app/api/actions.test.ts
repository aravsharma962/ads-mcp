import { describe, it, expect, vi, beforeEach } from "vitest";
import { seedDb, req, params, UA_OWNER, UA_MEMBER, UB_OWNER, CA, CB } from "@/test/harness";
import type { FakeDb } from "@/test/fakeDb";

const state = vi.hoisted(() => ({ db: null as any, user: null as string | null }));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => state.db.session(state.user) }));
const hub = vi.hoisted(() => ({ callTool: vi.fn() }));
vi.mock("@/lib/hub", () => {
  class HubError extends Error {
    status: number;
    constructor(status: number, m: string) { super(m); this.status = status; }
  }
  return { HubError, callTool: hub.callTool };
});

import { GET as actionsGet } from "./clients/[clientId]/actions/route";
import { GET as reportGet } from "./clients/[clientId]/report/route";
import { GET as rulesGet, PUT as rulesPut } from "./clients/[clientId]/rules/route";
import { GET as pagesGet } from "./clients/[clientId]/pages/route";
import { GET as leadsGet, PUT as leadsPut } from "./clients/[clientId]/leads/route";
import { computeWindows, fetchAllRows } from "@/lib/actions/data";

let db: FakeDb;
const adRow = (o: Record<string, unknown> = {}) => ({
  id: "a1", name: "Ad 1", campaign_id: "c1", adset_id: "s1", ad_id: "a1", thumbnail_url: null,
  spend: 1000, impressions: 20000, link_clicks: 400, landing_page_views: 300, add_to_cart: 50, purchases: 20, purchase_value: 8000,
  ctr: 2, cpc: 2.5, cpm: 50, roas: 8, frequency: 1.5, reach: 13000, ...o,
});
const call = (fn: any, path: string, id = CA, init: { method?: string; body?: unknown } = {}) =>
  fn(req(`/api/clients/${id}/${path}`, init), params({ clientId: id }));
const Q = "?from=2026-11-01&to=2026-11-07";
const addSite = (conv?: string[]) => db.rows("sites").push({ id: "s1", client_id: CA, site_key: "k", ...(conv ? { conversion_events: conv } : {}) });
const ev = (o: Record<string, unknown>) => db.rows("events").push({ client_id: CA, session_id: "s1", name: "page_view", ad_id: null, url: "https://x.com/", value: null, ts: "2026-11-03T10:00:00Z", ...o });

beforeEach(() => {
  db = seedDb();
  state.db = db;
  state.user = UA_OWNER;
  hub.callTool.mockReset().mockResolvedValue({ currency: "INR", rows: [adRow()] });
});

describe("computeWindows", () => {
  it("equal windows ending yesterday", () => {
    expect(computeWindows(7, "2026-11-21")).toEqual({
      recent: { from: "2026-11-14", to: "2026-11-20" },
      previous: { from: "2026-11-07", to: "2026-11-13" },
    });
  });
  it("crosses month and year boundaries", () => {
    expect(computeWindows(3, "2026-01-02")).toEqual({
      recent: { from: "2025-12-30", to: "2026-01-01" },
      previous: { from: "2025-12-27", to: "2025-12-29" },
    });
  });
});

describe("fetchAllRows", () => {
  const src = (n: number) => (from: number, to: number) => Promise.resolve({ data: Array.from({ length: n }, (_, i) => i).slice(from, to + 1), error: null });
  it("pages through and is not truncated at exactly the cap", async () => {
    const r = await fetchAllRows<number>(src(20000));
    expect(r.rows).toHaveLength(20000);
    expect(r.truncated).toBe(false);
  });
  it("truncates beyond the cap", async () => {
    const r = await fetchAllRows<number>(src(20500));
    expect(r.rows).toHaveLength(20000);
    expect(r.truncated).toBe(true);
  });
});

describe("GET actions", () => {
  it("404 for another agency's client, 401 signed out, hub untouched", async () => {
    expect((await call(actionsGet, "actions", CB)).status).toBe(404);
    state.user = null;
    expect((await call(actionsGet, "actions")).status).toBe(401);
    expect(hub.callTool).not.toHaveBeenCalled();
  });
  it("fetches ad-level recent and previous windows and returns the response shape", async () => {
    const res = await call(actionsGet, "actions");
    expect(res.status).toBe(200);
    const body = await res.json();
    const levels = hub.callTool.mock.calls.map((c) => c[2]);
    expect(levels).toHaveLength(2);
    expect(levels.every((l) => l.level === "ad")).toBe(true);
    expect(levels[0].date_from).toBe(body.windows.recent.from);
    expect(levels[1].date_to).toBe(body.windows.previous.to);
    expect(body.rules.frequency_max).toBe(3);
    expect(body.result_label).toBe("purchase");
    expect(body.actions).toHaveLength(1);
    expect(Object.keys(body.counts).sort()).toEqual(["keep_watch", "pause", "refresh_creative", "scale", "too_early"]);
    expect(body.ad_account).toBe(true);
  });
  it("previous window with no data does not produce a drop signal", async () => {
    hub.callTool.mockResolvedValueOnce({ currency: "INR", rows: [adRow()] }).mockResolvedValueOnce({ currency: "INR", rows: [] });
    const body = await (await call(actionsGet, "actions")).json();
    expect(body.actions[0].signals).toEqual({ frequency: false, ctr_drop: false, cost_rise: false });
  });
  it("uses the client's saved rules", async () => {
    db.rows("clients").find((c) => c.id === CA)!.action_rules = { window_days: 14, frequency_max: 1.2 };
    const body = await (await call(actionsGet, "actions")).json();
    expect(body.rules.window_days).toBe(14);
    expect(body.windows.recent.from < body.windows.recent.to).toBe(true);
    expect(body.actions[0].signals.frequency).toBe(true);
  });
  it("no ad account: 200 with empty lists and ad_account false, hub not called", async () => {
    db.tables.client_accounts = [];
    const res = await call(actionsGet, "actions");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.actions).toEqual([]);
    expect(body.winners).toEqual([]);
    expect(body.ad_account).toBe(false);
    expect(hub.callTool).not.toHaveBeenCalled();
  });
  it("hub failure is a plain 502", async () => {
    const { HubError } = await import("@/lib/hub");
    hub.callTool.mockRejectedValue(new HubError(500, "Traceback secret"));
    const res = await call(actionsGet, "actions");
    expect(res.status).toBe(502);
    expect(JSON.stringify(await res.json())).not.toContain("Traceback");
  });
});

describe("GET report", () => {
  it("returns the report with whatsapp text", async () => {
    const res = await call(reportGet, "report");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.client_name).toBe("Client A");
    expect(typeof body.whatsapp_text).toBe("string");
    expect(body.whatsapp_text.length).toBeGreaterThan(0);
    expect(body.recent.spend).toBe(1000);
  });
  it("404 other tenant; 502 on hub failure; no ad account is not an error", async () => {
    expect((await call(reportGet, "report", CB)).status).toBe(404);
    hub.callTool.mockRejectedValue(new Error("boom"));
    expect((await call(reportGet, "report")).status).toBe(502);
    db.tables.client_accounts = [];
    const res = await call(reportGet, "report");
    expect(res.status).toBe(200);
    expect((await res.json()).ad_account).toBe(false);
  });
});

describe("rules", () => {
  it("GET returns defaults for an empty client", async () => {
    expect((await (await call(rulesGet, "rules")).json()).rules.window_days).toBe(7);
    expect((await call(rulesGet, "rules", CB)).status).toBe(404);
  });
  it("PUT clamps, merges with saved rules and persists", async () => {
    let res = await call(rulesPut, "rules", CA, { method: "PUT", body: { frequency_max: 99, window_days: 10.4 } });
    expect(res.status).toBe(200);
    expect((await res.json()).rules).toMatchObject({ frequency_max: 20, window_days: 10, ctr_drop_pct: 25 });
    res = await call(rulesPut, "rules", CA, { method: "PUT", body: { ctr_drop_pct: 40 } });
    expect((await res.json()).rules).toMatchObject({ frequency_max: 20, ctr_drop_pct: 40 });
    expect(db.rows("clients").find((c) => c.id === CA)!.action_rules.ctr_drop_pct).toBe(40);
  });
  it("PUT rejects bad input with 400, non-owner 403, other tenant 404", async () => {
    for (const body of [{}, { frequency_max: "3" }, { bogus: 1 }, { frequency_max: null }, [1], "x"]) {
      const r = await call(rulesPut, "rules", CA, { method: "PUT", body });
      expect(r.status, JSON.stringify(body)).toBe(400);
      expect(typeof (await r.json()).error).toBe("string");
    }
    expect((await call(rulesPut, "rules", CB, { method: "PUT", body: { frequency_max: 2 } })).status).toBe(404);
    state.user = UA_MEMBER;
    expect((await call(rulesPut, "rules", CA, { method: "PUT", body: { frequency_max: 2 } })).status).toBe(403);
    expect(db.rows("clients").find((c) => c.id === CA)!.action_rules).toBeUndefined();
  });
});

describe("GET pages", () => {
  it("no site: 200, tracking false, empty lists", async () => {
    const res = await call(pagesGet, "pages" + Q);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ tracking: false, pages: [], retargeting: [], sessions: 0, truncated: false });
    expect(hub.callTool).not.toHaveBeenCalled();
  });
  it("400 on bad dates, 404 other tenant", async () => {
    expect((await call(pagesGet, "pages?from=x&to=y")).status).toBe(400);
    expect((await call(pagesGet, "pages" + Q, CB)).status).toBe(404);
  });
  it("counts a session once per page, only this client's events inside the window", async () => {
    addSite();
    ev({ session_id: "s1", ts: "2026-11-03T10:00:00Z" });
    ev({ session_id: "s1", ts: "2026-11-03T10:00:05Z" }); // same page again
    ev({ session_id: "s1", name: "page_leave", value: 3, ts: "2026-11-03T10:00:08Z" });
    ev({ session_id: "s2", url: "https://x.com/pricing" });
    ev({ session_id: "old", ts: "2026-10-01T00:00:00Z" });
    ev({ session_id: "late", ts: "2026-11-07T18:00:00Z" }); // Nov 7 23:30 in Asia/Kolkata: inside
    ev({ session_id: "next-day", ts: "2026-11-07T19:00:00Z" }); // Nov 8 00:30 in Asia/Kolkata: outside
    ev({ session_id: "other", client_id: CB });
    const body = await (await call(pagesGet, "pages" + Q)).json();
    expect(body.tracking).toBe(true);
    expect(body.sessions).toBe(3);
    expect(body.bounced_sessions).toBe(1);
    expect(body.pages.find((p: any) => p.url === "https://x.com/").sessions).toBe(2);
    expect(body.truncated).toBe(false);
  });
  it("hub failure for ad names is a 502", async () => {
    addSite();
    hub.callTool.mockRejectedValue(new Error("boom"));
    expect((await call(pagesGet, "pages" + Q)).status).toBe(502);
  });
  it("uses the site's conversion events and ad names in retargeting", async () => {
    addSite(["purchase"]);
    for (let i = 0; i < 5; i++) ev({ session_id: "p" + i, ad_id: "a1", url: "https://x.com/pricing" });
    const body = await (await call(pagesGet, "pages" + Q)).json();
    expect(body.retargeting[0]).toMatchObject({ ad_id: "a1", ad_name: "Ad 1", visitors: 5 });
  });
  it("sets truncated when more than 20000 events exist", async () => {
    addSite();
    for (let i = 0; i < 20001; i++) db.rows("events").push({ id: i + 1, client_id: CA, session_id: "s" + i, name: "page_view", ad_id: null, url: "https://x.com/", value: null, ts: "2026-11-03T10:00:00Z" });
    const body = await (await call(pagesGet, "pages" + Q)).json();
    expect(body.truncated).toBe(true);
    expect(body.sessions).toBe(20000);
  });
  it("keeps the most recent events when capping", async () => {
    addSite();
    for (let i = 0; i < 20001; i++) db.rows("events").push({ id: i + 1, client_id: CA, session_id: "s" + i, name: "page_view", ad_id: null, url: "https://x.com/" + (i === 0 ? "oldest" : ""), value: null, ts: "2026-11-03T10:00:00Z" });
    const body = await (await call(pagesGet, "pages" + Q)).json();
    expect(body.pages.find((p: any) => p.url === "https://x.com/oldest")).toBeUndefined();
  });
});

describe("leads", () => {
  it("no site: tracking false and empty", async () => {
    const body = await (await call(leadsGet, "leads" + Q)).json();
    expect(body).toMatchObject({ tracking: false, leads: [], total: 0, cost_per_lead: null });
  });
  it("one row per session, marks applied, spend from totals, ad names", async () => {
    addSite();
    ev({ session_id: "L1", name: "lead", ad_id: "a1", ts: "2026-11-02T10:00:00Z" });
    ev({ session_id: "L1", name: "form_submit", ad_id: "a1", ts: "2026-11-03T10:00:00Z" });
    ev({ session_id: "L2", name: "form_submit", ts: "2026-11-04T10:00:00Z" });
    ev({ session_id: "L3", name: "lead", client_id: CB });
    ev({ session_id: "V", name: "page_view" });
    db.rows("lead_marks").push({ client_id: CA, session_id: "L1", status: "qualified" });
    db.rows("lead_marks").push({ client_id: CB, session_id: "L2", status: "won" });
    const body = await (await call(leadsGet, "leads" + Q)).json();
    expect(body.total).toBe(2);
    expect(body.leads.map((l: any) => [l.session_id, l.status])).toEqual([["L2", "new"], ["L1", "qualified"]]);
    expect(body.leads[1].ad_name).toBe("Ad 1");
    expect(body.qualified).toBe(1);
    expect(body.spend).toBe(1000);
    expect(body.attributed_total).toBe(1); // L2 is organic
    expect(body.cost_per_lead).toBe(1000);
    expect(body.cost_per_qualified_lead).toBe(1000);
  });
  it("keeps the most recent leads when capping", async () => {
    addSite();
    for (let i = 0; i < 20001; i++) db.rows("events").push({ id: i + 1, client_id: CA, session_id: "s" + i, name: "lead", ad_id: "a1", url: null, value: null, ts: "2026-11-03T10:00:00Z" });
    const body = await (await call(leadsGet, "leads" + Q)).json();
    expect(body.truncated).toBe(true);
    expect(body.leads.find((l: any) => l.session_id === "s0")).toBeUndefined();
    expect(body.leads.find((l: any) => l.session_id === "s20000")).toBeDefined();
  });
  it("no ad account: costs null, not an error", async () => {
    addSite();
    db.tables.client_accounts = [];
    ev({ session_id: "L1", name: "lead" });
    const res = await call(leadsGet, "leads" + Q);
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body).toMatchObject({ total: 1, cost_per_lead: null, ad_account: false });
  });
  it("PUT upserts only for a session with a lead event of this client", async () => {
    addSite();
    ev({ session_id: "L1", name: "lead" });
    ev({ session_id: "V", name: "page_view" });
    ev({ session_id: "X", name: "lead", client_id: CB });
    const put = (b: unknown, id = CA) => call(leadsPut, "leads", id, { method: "PUT", body: b });
    expect((await put({ session_id: "L1", status: "won" })).status).toBe(200);
    expect((await put({ session_id: "L1", status: "lost" })).status).toBe(200);
    expect(db.rows("lead_marks")).toEqual([expect.objectContaining({ client_id: CA, session_id: "L1", status: "lost" })]);
    expect((await put({ session_id: "V", status: "won" })).status).toBe(404);
    expect((await put({ session_id: "X", status: "won" })).status).toBe(404);
    expect((await put({ session_id: "L1", status: "maybe" })).status).toBe(400);
    expect((await put({ session_id: "", status: "won" })).status).toBe(400);
    expect((await put({ status: "won" })).status).toBe(400);
    expect((await put({ session_id: "X", status: "won" }, CB)).status).toBe(404); // A cannot touch B
    state.user = UB_OWNER;
    expect((await put({ session_id: "L1", status: "won" }, CA)).status).toBe(404);
    expect(db.rows("lead_marks").some((m) => m.client_id === CA && m.status === "won")).toBe(false);
  });
});
