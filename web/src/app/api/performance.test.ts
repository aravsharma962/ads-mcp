import { describe, it, expect, vi, beforeEach } from "vitest";
import { seedDb, req, params, UA_OWNER, UB_OWNER, CA, CB } from "@/test/harness";
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

import { GET } from "./clients/[clientId]/performance/route";

let db: FakeDb;
const metaRow = (o: Record<string, unknown> = {}) => ({
  id: "c1", name: "Camp 1", campaign_id: "c1", adset_id: null, ad_id: null, thumbnail_url: null,
  spend: 100, impressions: 10000, link_clicks: 100, landing_page_views: 80, add_to_cart: 20, purchases: 5, purchase_value: 500,
  ctr: 1, cpc: 1, cpm: 10, roas: 5, ...o,
});
const get = (qs: string, id = CA) => GET(req(`/api/clients/${id}/performance?${qs}`), params({ clientId: id }));
const Q = "from=2026-11-01&to=2026-11-07&level=campaign";

beforeEach(() => {
  db = seedDb();
  state.db = db;
  state.user = UA_OWNER;
  hub.callTool.mockReset().mockResolvedValue({ currency: "INR", attribution: "account default", rows: [metaRow()] });
});

describe("GET performance", () => {
  it("404 for another agency's client, hub never called", async () => {
    const res = await get(Q, CB);
    expect(res.status).toBe(404);
    expect(hub.callTool).not.toHaveBeenCalled();
    expect(JSON.stringify(await res.json())).not.toContain("act_999777");
  });
  it("401 when signed out", async () => {
    state.user = null;
    expect((await get(Q)).status).toBe(401);
  });
  it("invalid dates, level, and ranges are 400", async () => {
    for (const qs of [
      "from=2026-13-01&to=2026-11-07&level=ad",
      "from=abc&to=2026-11-07&level=ad",
      "from=2026-11-08&to=2026-11-07&level=ad",
      "from=2026-11-01&to=2026-11-07&level=bogus",
      "to=2026-11-07&level=ad",
      "from=2025-01-01&to=2026-11-07&level=ad",
    ]) expect((await get(qs)).status, qs).toBe(400);
    expect(hub.callTool).not.toHaveBeenCalled();
  });
  it("accepts a 366-day range but not 367", async () => {
    expect((await get("from=2025-11-07&to=2026-11-07&level=ad")).status).toBe(200);
    expect((await get("from=2025-11-06&to=2026-11-07&level=ad")).status).toBe(400);
  });
  it("without a site, uses meta_ads_insights per account with the client's own account ids", async () => {
    const res = await get(Q);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(hub.callTool).toHaveBeenCalledTimes(1);
    expect(hub.callTool).toHaveBeenCalledWith("11111111-1111-4111-8111-111111111111", "meta_ads_insights", {
      external_id: "act_111", date_from: "2026-11-01", date_to: "2026-11-07", level: "campaign",
    });
    expect(body.tracking).toBe(false);
    expect(body.currency).toBe("INR");
    expect(body.rows[0].rates.ctr).toBeCloseTo(1);
    expect(body.rows[0].rates.roas).toBeCloseTo(5);
    expect(body.rows[0].rates.visit_rate).toBeNull();
    expect(body.totals.rates.cpm).toBeCloseTo(10);
  });
  it("with a site, calls ads_performance with the client id from the session-resolved client", async () => {
    db.rows("sites").push({ id: "s1", client_id: CA, site_key: "k" });
    hub.callTool.mockResolvedValue({
      currency: "INR",
      rows: [{ ...metaRow({ ad_id: "a1" }), sessions: 80, add_to_cart_sessions: 14, conversion_sessions: 10, tracked_value: 900 }],
      unattributed: { sessions: 3, add_to_cart_sessions: 1, conversion_sessions: 0 },
    });
    const body = await (await get("from=2026-11-01&to=2026-11-07&level=ad")).json();
    expect(hub.callTool.mock.calls[0][1]).toBe("ads_performance");
    expect(hub.callTool.mock.calls[0][2]).toEqual({ client_id: CA, date_from: "2026-11-01", date_to: "2026-11-07", level: "ad" });
    expect(body.tracking).toBe(true);
    expect(body.rows[0].rates.visit_rate).toBeCloseTo(80);
    expect(body.rows[0].rates.add_to_cart_rate).toBeCloseTo(14);
    expect(body.rows[0].rates.conversion_rate).toBeCloseTo(10);
    expect(body.rows[0].rates.roas).toBeCloseTo(9);
    expect(body.unattributed.sessions).toBe(3);
  });
  it("roas_source meta uses Meta purchase value even with tracking", async () => {
    db.rows("sites").push({ id: "s1", client_id: CA, site_key: "k" });
    db.rows("clients").find((c) => c.id === CA)!.roas_source = "meta";
    hub.callTool.mockResolvedValue({ currency: "INR", rows: [{ ...metaRow(), sessions: 1, add_to_cart_sessions: 0, conversion_sessions: 0, tracked_value: 900 }], unattributed: null });
    const body = await (await get(Q)).json();
    expect(body.rows[0].rates.roas).toBeCloseTo(5);
  });
  it("zero rows is an empty list with null-rate totals, no NaN", async () => {
    hub.callTool.mockResolvedValue({ currency: "INR", rows: [] });
    const body = await (await get(Q)).json();
    expect(body.rows).toEqual([]);
    expect(Object.values(body.totals.rates).every((v) => v === null)).toBe(true);
  });
  it("zero impressions and clicks give null rates", async () => {
    hub.callTool.mockResolvedValue({ currency: "INR", rows: [metaRow({ impressions: 0, link_clicks: 0, spend: 0, ctr: null, cpc: null })] });
    const body = await (await get(Q)).json();
    const r = body.rows[0].rates;
    expect([r.ctr, r.cpc, r.cpm, r.roas]).toEqual([null, null, null, null]);
  });
  it("sums totals across accounts and recomputes rates from sums", async () => {
    db.rows("client_accounts").push({ client_id: CA, platform: "meta", external_id: "act_A2" });
    hub.callTool
      .mockResolvedValueOnce({ currency: "INR", rows: [metaRow({ spend: 100, impressions: 1000, link_clicks: 10 })] })
      .mockResolvedValueOnce({ currency: "INR", rows: [metaRow({ id: "c2", spend: 300, impressions: 3000, link_clicks: 90 })] });
    const body = await (await get(Q)).json();
    expect(body.totals.spend).toBe(400);
    expect(body.totals.rates.cpc).toBeCloseTo(4);
    expect(body.totals.rates.ctr).toBeCloseTo(2.5);
  });
  it("sanitises non-https thumbnails and non-numeric values", async () => {
    hub.callTool.mockResolvedValue({ currency: "INR", rows: [metaRow({ thumbnail_url: "javascript:alert(1)", spend: "abc" })] });
    const body = await (await get(Q)).json();
    expect(body.rows[0].thumbnail_url).toBeNull();
    expect(body.rows[0].spend).toBe(0);
  });
  it("hub failure gives a clear 502 with no internals", async () => {
    const { HubError } = await import("@/lib/hub");
    hub.callTool.mockRejectedValue(new HubError(500, "Traceback secret"));
    const res = await get(Q);
    expect(res.status).toBe(502);
    expect(JSON.stringify(await res.json())).not.toContain("Traceback");
  });
  it("no accounts yet: empty result without calling hub", async () => {
    db.tables.client_accounts = [];
    const body = await (await get(Q)).json();
    expect(body.rows).toEqual([]);
    expect(hub.callTool).not.toHaveBeenCalled();
  });
  it("B's owner cannot read A's data", async () => {
    state.user = UB_OWNER;
    expect((await get(Q, CA)).status).toBe(404);
  });
});
