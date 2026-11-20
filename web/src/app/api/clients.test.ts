import { describe, it, expect, vi, beforeEach } from "vitest";
import { hardenedSession, seedDb, req, params, TA, UA_OWNER, UA_MEMBER, UB_OWNER, CA, CB } from "@/test/harness";
import type { FakeDb } from "@/test/fakeDb";

const state = vi.hoisted(() => ({ db: null as any, user: null as string | null }));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => hardenedSession(state.db, state.user) }));
vi.mock("@/lib/supabase/service", () => ({ createServiceClient: () => state.db }));
const hub = vi.hoisted(() => ({
  addAccount: vi.fn(),
  listAccounts: vi.fn(),
  removeAccount: vi.fn(),
  callTool: vi.fn(),
}));
vi.mock("@/lib/hub", () => {
  class HubError extends Error {
    status: number;
    constructor(status: number, m: string) { super(m); this.status = status; }
  }
  return { HubError, addAccount: hub.addAccount, removeAccount: hub.removeAccount, listAccounts: hub.listAccounts, callTool: hub.callTool };
});

import { POST as createClient, GET as listClients } from "./clients/route";
import { GET as getAccounts, POST as postAccount, DELETE as deleteAccount } from "./clients/[clientId]/accounts/route";
import { GET as getTargets, PUT as putTargets } from "./clients/[clientId]/targets/route";
import { DEFAULT_TARGETS, metricsForType } from "@/lib/metrics";
import { PATCH as patchClient } from "./clients/[clientId]/route";
import { POST as postSite } from "./clients/[clientId]/site/route";
import { GET as getPerf } from "./clients/[clientId]/performance/route";

const METRIC_KEYS = metricsForType("ecommerce");

let db: FakeDb;
beforeEach(() => {
  db = seedDb();
  state.db = db;
  state.user = UA_OWNER;
  hub.listAccounts.mockReset().mockResolvedValue([]);
  hub.addAccount.mockReset().mockResolvedValue({ external_id: "act_555" });
  hub.removeAccount.mockReset().mockResolvedValue(true);
  hub.callTool.mockReset().mockResolvedValue({ currency: "INR", attribution: "account default", rows: [] });
});

describe("POST /api/clients", () => {
  const body = { name: "New Client", currency: "inr", timezone: "Asia/Kolkata", business_type: "ecommerce" };
  it("member gets 403", async () => {
    state.user = UA_MEMBER;
    const res = await createClient(req("/api/clients", { method: "POST", body }));
    expect(res.status).toBe(403);
  });
  it("signed out gets 401", async () => {
    state.user = null;
    expect((await createClient(req("/api/clients", { method: "POST", body }))).status).toBe(401);
  });
  it("owner creates client for own tenant and seeds default targets", async () => {
    const res = await createClient(req("/api/clients", { method: "POST", body: { ...body, tenant_id: "evil" } }));
    expect(res.status).toBe(201);
    const { client } = await res.json();
    const row = db.rows("clients").find((c) => c.id === client.id)!;
    expect(row.tenant_id).toBe(TA);
    expect(row.currency).toBe("INR");
    const t = db.rows("targets").filter((r) => r.client_id === client.id);
    expect(t.map((r) => r.metric).sort()).toEqual([...METRIC_KEYS].sort());
    const roas = t.find((r) => r.metric === "roas")!;
    expect([roas.min_value, roas.max_value]).toEqual([DEFAULT_TARGETS.roas.min, DEFAULT_TARGETS.roas.max]);
  });
  it("validates input", async () => {
    const res = await createClient(req("/api/clients", { method: "POST", body: { name: "", currency: "rupee", timezone: "x" } }));
    expect(res.status).toBe(400);
  });
  it("list only shows own tenant's clients", async () => {
    const res = await listClients();
    const { clients } = await res.json();
    expect(clients.map((c: any) => c.id)).toEqual([CA]);
  });
});

describe("tenant isolation on accounts and targets", () => {
  it("owner of A gets 404 for B's client on every verb", async () => {
    const p = params({ clientId: CB });
    for (const res of [
      await getAccounts(req(`/api/clients/${CB}/accounts`), p),
      await postAccount(req(`/api/clients/${CB}/accounts`, { method: "POST", body: { account: "act_9", token: "tok" } }), p),
      await deleteAccount(req(`/api/clients/${CB}/accounts?external_id=act_999777`, { method: "DELETE" }), p),
      await getTargets(req(`/api/clients/${CB}/targets`), p),
      await putTargets(req(`/api/clients/${CB}/targets`, { method: "PUT", body: { reset: true } }), p),
    ]) {
      expect(res.status).toBe(404);
      expect(JSON.stringify(await res.json())).not.toContain("act_999777");
    }
    expect(hub.addAccount).not.toHaveBeenCalled();
    expect(hub.removeAccount).not.toHaveBeenCalled();
    expect(db.rows("client_accounts").some((a) => a.external_id === "act_999777")).toBe(true);
    expect(db.rows("targets").find((t) => t.client_id === CB)!.min_value).toBe(7);
  });
  it("malformed client id is 404", async () => {
    const res = await getTargets(req("/api/clients/xyz/targets"), params({ clientId: "xyz" }));
    expect(res.status).toBe(404);
  });
  it("B's owner cannot see A's client either", async () => {
    state.user = UB_OWNER;
    expect((await getAccounts(req("/x"), params({ clientId: CA }))).status).toBe(404);
  });
});

describe("accounts", () => {
  const p = params({ clientId: CA });
  const post = (b: unknown) => postAccount(req(`/api/clients/${CA}/accounts`, { method: "POST", body: b }), p);

  it("member cannot add", async () => {
    state.user = UA_MEMBER;
    expect((await post({ account: "act_555", token: "tok" })).status).toBe(403);
  });
  it("adds account, verifies currency, never returns the token", async () => {
    const res = await post({ account: "act_555", token: "EAAB-super-secret-token-value" });
    expect(res.status).toBe(201);
    expect(JSON.stringify(await res.json())).not.toContain("super-secret");
    expect(hub.addAccount).toHaveBeenCalledWith(TA, "act_555", "EAAB-super-secret-token-value");
    expect(db.rows("client_accounts").some((a) => a.client_id === CA && a.external_id === "act_555")).toBe(true);
  });
  it("currency mismatch is rejected with 400, mentions currency, account is rolled back", async () => {
    hub.callTool.mockResolvedValue({ currency: "USD", rows: [] });
    const res = await post({ account: "act_555", token: "tok" });
    expect(res.status).toBe(400);
    const { error } = await res.json();
    expect(error).toMatch(/currency/i);
    expect(error).toContain("USD");
    expect(hub.removeAccount).toHaveBeenCalledWith(TA, "act_555");
    expect(db.rows("client_accounts").some((a) => a.external_id === "act_555")).toBe(false);
  });
  it("hub failure while verifying does not store the account and leaks no token", async () => {
    const { HubError } = await import("@/lib/hub");
    hub.callTool.mockRejectedValue(new HubError(502, "Meta rejected the token"));
    const res = await post({ account: "act_555", token: "tok-abc" });
    expect(res.status).toBe(400);
    expect(JSON.stringify(await res.json())).not.toContain("tok-abc");
    expect(db.rows("client_accounts").some((a) => a.external_id === "act_555")).toBe(false);
  });
  it("normalises the account id before every lookup, hub call and insert", async () => {
    hub.addAccount.mockResolvedValue({ external_id: "act_555" });
    expect((await post({ account: "555", token: "tok" })).status).toBe(201);
    expect(hub.addAccount).toHaveBeenCalledWith(TA, "act_555", "tok");
    expect(db.rows("client_accounts").some((a) => a.client_id === CA && a.external_id === "act_555")).toBe(true);
    // same account typed differently is a duplicate, not a second row
    expect((await post({ account: "ACT_555", token: "tok" })).status).toBe(409);
    expect((await post({ account: "act_5 55", token: "tok" })).status).toBe(400);
  });
  it("normalises on rollback and delete", async () => {
    hub.callTool.mockResolvedValue({ currency: "USD", rows: [] });
    await post({ account: "555", token: "tok" });
    expect(hub.removeAccount).toHaveBeenCalledWith(TA, "act_555");
    hub.removeAccount.mockClear();
    const res = await deleteAccount(req("/x?external_id=111", { method: "DELETE" }), p);
    expect(res.status).toBe(200);
    expect(db.rows("client_accounts").some((a) => a.external_id === "act_111")).toBe(false);
    expect(hub.removeAccount).toHaveBeenCalledWith(TA, "act_111");
  });
  it("pre-existing hub connection: token is NOT replaced, nothing is rolled back on failure", async () => {
    hub.listAccounts.mockResolvedValue([{ platform: "meta", external_id: "act_777" }]);
    hub.callTool.mockResolvedValue({ currency: "USD", rows: [] });   // mismatch
    const res = await post({ account: "act_777", token: "attacker-token" });
    expect(res.status).toBe(400);
    expect(hub.addAccount).not.toHaveBeenCalled();
    expect(hub.removeAccount).not.toHaveBeenCalled();
    expect(db.rows("client_accounts").some((a) => a.external_id === "act_777")).toBe(false);
  });
  it("pre-existing hub connection can be linked using its stored token", async () => {
    hub.listAccounts.mockResolvedValue([{ platform: "meta", external_id: "act_777" }]);
    const res = await post({ account: "act_777", token: "ignored" });
    expect(res.status).toBe(201);
    expect(hub.addAccount).not.toHaveBeenCalled();
    expect(db.rows("client_accounts").some((a) => a.client_id === CA && a.external_id === "act_777")).toBe(true);
  });
  it("pre-existing hub connection survives a failed save", async () => {
    hub.listAccounts.mockResolvedValue([{ platform: "meta", external_id: "act_777" }]);
    hub.callTool.mockRejectedValue(new Error("x"));
    await post({ account: "act_777", token: "t" });
    expect(hub.removeAccount).not.toHaveBeenCalled();
  });
  it("rollback never removes a connection another client of the tenant uses", async () => {
    db.rows("clients").push({ id: "ca000000-0000-4000-8000-000000000002", tenant_id: TA, name: "A2", currency: "INR", timezone: "x" });
    db.rows("client_accounts").push({ client_id: "ca000000-0000-4000-8000-000000000002", platform: "meta", external_id: "act_555" });
    hub.callTool.mockResolvedValue({ currency: "USD", rows: [] });
    await post({ account: "act_555", token: "t" });
    expect(hub.removeAccount).not.toHaveBeenCalled();
  });
  it("missing currency from the hub is a failed check and rolls back what this request created", async () => {
    hub.callTool.mockResolvedValue({ rows: [] });
    const res = await post({ account: "act_555", token: "tok" });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/currency/i);
    expect(hub.removeAccount).toHaveBeenCalledWith(TA, "act_555");
    expect(db.rows("client_accounts").some((a) => a.external_id === "act_555")).toBe(false);
  });
  it("invalid input is 400 and hub is not called", async () => {
    expect((await post({ account: "bad id!", token: "tok" })).status).toBe(400);
    expect((await post({ account: "act_1", token: "" })).status).toBe(400);
    expect(hub.addAccount).not.toHaveBeenCalled();
  });
  it("list returns only external ids", async () => {
    const res = await getAccounts(req("/x"), p);
    expect(await res.json()).toEqual({ accounts: [{ platform: "meta", external_id: "act_111" }], currency: "INR", timezone: "Asia/Kolkata" });
  });
  it("owner removes account; hub account removed when unused elsewhere", async () => {
    const res = await deleteAccount(req("/x?external_id=act_111", { method: "DELETE" }), p);
    expect(res.status).toBe(200);
    expect(db.rows("client_accounts").some((a) => a.external_id === "act_111")).toBe(false);
    expect(hub.removeAccount).toHaveBeenCalledWith(TA, "act_111");
  });
  it("remove keeps hub connection if another client of the tenant still uses it", async () => {
    db.rows("clients").push({ id: "ca000000-0000-4000-8000-000000000002", tenant_id: TA, name: "A2", currency: "INR", timezone: "x" });
    db.rows("client_accounts").push({ client_id: "ca000000-0000-4000-8000-000000000002", platform: "meta", external_id: "act_111" });
    await deleteAccount(req("/x?external_id=act_111", { method: "DELETE" }), p);
    expect(hub.removeAccount).not.toHaveBeenCalled();
  });
  it("removing an unknown account is 404", async () => {
    expect((await deleteAccount(req("/x?external_id=act_424242", { method: "DELETE" }), p)).status).toBe(404);
  });
});

describe("targets", () => {
  const p = params({ clientId: CA });
  it("GET returns all metrics, defaults filled in", async () => {
    const { targets } = await (await getTargets(req("/x"), p)).json();
    expect(Object.keys(targets).sort()).toEqual([...METRIC_KEYS].sort());
    expect(targets.ctr).toEqual({ min: 3, max: null });
    expect(targets.roas).toEqual(DEFAULT_TARGETS.roas);
  });
  it("member may save targets", async () => {
    state.user = UA_MEMBER;
    const res = await putTargets(req("/x", { method: "PUT", body: { targets: { cpc: { min: null, max: 15 } } } }), p);
    expect(res.status).toBe(200);
    const row = db.rows("targets").find((t) => t.client_id === CA && t.metric === "cpc")!;
    expect([row.min_value, row.max_value]).toEqual([null, 15]);
  });
  it("rejects min greater than max and unknown metrics", async () => {
    expect((await putTargets(req("/x", { method: "PUT", body: { targets: { cpc: { min: 30, max: 15 } } } }), p)).status).toBe(400);
    expect((await putTargets(req("/x", { method: "PUT", body: { targets: { bogus: { min: 1, max: 2 } } } }), p)).status).toBe(400);
  });
  it("reset restores defaults", async () => {
    await putTargets(req("/x", { method: "PUT", body: { targets: { roas: { min: 1, max: 2 } } } }), p);
    await putTargets(req("/x", { method: "PUT", body: { reset: true } }), p);
    const row = db.rows("targets").find((t) => t.client_id === CA && t.metric === "roas")!;
    expect([row.min_value, row.max_value]).toEqual([9, 12]);
  });
});

const setType = (id: string, t: string) => { db.rows("clients").find((c) => c.id === id)!.business_type = t; };

describe("business type on create", () => {
  const mk = (b: Record<string, unknown>) => createClient(req("/api/clients", { method: "POST", body: { name: "N", currency: "INR", timezone: "Asia/Kolkata", ...b } }));
  it("requires a valid business type", async () => {
    for (const bt of [undefined, "", "retail", 5, null]) expect((await mk({ business_type: bt })).status, String(bt)).toBe(400);
    expect(db.rows("clients")).toHaveLength(2);
  });
  it.each([["lead_gen"], ["saas_b2b"], ["ecommerce"]] as const)("%s: stored and the type's targets seeded", async (bt) => {
    const res = await mk({ business_type: bt });
    expect(res.status).toBe(201);
    const { client } = await res.json();
    expect(client.business_type).toBe(bt);
    expect(db.rows("clients").find((c) => c.id === client.id)!.business_type).toBe(bt);
    const t = db.rows("targets").filter((r) => r.client_id === client.id);
    expect(t.map((r) => r.metric).sort()).toEqual([...metricsForType(bt)].sort());
    for (const r of t.filter((x) => !["ctr", "cpc", "cpm", "visit_rate", "add_to_cart_rate", "conversion_rate", "roas"].includes(x.metric))) {
      expect([r.min_value, r.max_value]).toEqual([null, null]);
    }
  });
  it("list includes the type", async () => {
    setType(CA, "lead_gen");
    const { clients } = await (await listClients()).json();
    expect(clients[0].business_type).toBe("lead_gen");
  });
});

describe("targets by business type", () => {
  const p = params({ clientId: CA });
  it("GET returns only the type's metrics, new ones empty", async () => {
    setType(CA, "saas_b2b");
    const { targets } = await (await getTargets(req("/x"), p)).json();
    expect(Object.keys(targets).sort()).toEqual([...metricsForType("saas_b2b")].sort());
    for (const k of ["cpl", "signup_rate", "demo_rate", "cost_per_trial", "cac"]) expect(targets[k]).toEqual({ min: null, max: null });
    expect(targets.ctr).toEqual({ min: 3, max: null });
    expect(targets.roas).toBeUndefined();
  });
  it("a client without a stored type behaves as ecommerce", async () => {
    const { targets } = await (await getTargets(req("/x"), p)).json();
    expect(Object.keys(targets).sort()).toEqual([...METRIC_KEYS].sort());
  });
  it("PUT saves new-type metrics and rejects metrics of another type", async () => {
    setType(CA, "lead_gen");
    const ok = await putTargets(req("/x", { method: "PUT", body: { targets: { cpl: { min: null, max: 400 }, lead_rate: { min: 5, max: null } } } }), p);
    expect(ok.status).toBe(200);
    const saved = (await ok.json()).targets;
    expect(saved.cpl).toEqual({ min: null, max: 400 });
    expect(saved.roas).toBeUndefined();
    const bad = await putTargets(req("/x", { method: "PUT", body: { targets: { roas: { min: 1, max: 2 } } } }), p);
    expect(bad.status).toBe(400);
    expect(db.rows("targets").some((t) => t.client_id === CA && t.metric === "roas")).toBe(false);
    expect((await putTargets(req("/x", { method: "PUT", body: { targets: { cac: { min: null, max: 5 } } } }), p)).status).toBe(400);
  });
  it("reset only touches the type's metrics and leaves new ones empty", async () => {
    setType(CA, "saas_b2b");
    await putTargets(req("/x", { method: "PUT", body: { targets: { cac: { min: null, max: 5 }, ctr: { min: 9, max: null } } } }), p);
    const res = await putTargets(req("/x", { method: "PUT", body: { reset: true } }), p);
    const { targets } = await res.json();
    expect(targets.cac).toEqual({ min: null, max: null });
    expect(targets.ctr).toEqual({ min: 3, max: null });
    expect(db.rows("targets").some((t) => t.client_id === CA && t.metric === "roas" && t.min_value !== 9)).toBe(false);
  });
});

describe("PATCH /api/clients/[id] (change business type)", () => {
  const p = params({ clientId: CA });
  const patch = (b: unknown, id = CA) => patchClient(req(`/api/clients/${id}`, { method: "PATCH", body: b }), params({ clientId: id }));
  it("owner switches type; missing target rows are created empty, existing rows are kept", async () => {
    db.rows("targets").find((t) => t.client_id === CA && t.metric === "ctr")!.min_value = 4;
    const res = await patch({ business_type: "saas_b2b" });
    expect(res.status).toBe(200);
    expect((await res.json()).client.business_type).toBe("saas_b2b");
    expect(db.rows("clients").find((c) => c.id === CA)!.business_type).toBe("saas_b2b");
    const rows = db.rows("targets").filter((t) => t.client_id === CA);
    expect(rows.map((r) => r.metric).sort()).toEqual(expect.arrayContaining([...metricsForType("saas_b2b")]));
    expect(rows.find((r) => r.metric === "ctr")!.min_value).toBe(4);
    expect(rows.find((r) => r.metric === "cac")).toMatchObject({ min_value: null, max_value: null });
    const { targets } = await (await getTargets(req("/x"), p)).json();
    expect(Object.keys(targets).sort()).toEqual([...metricsForType("saas_b2b")].sort());
  });
  it("switching back restores the e-commerce view without losing its targets", async () => {
    await patch({ business_type: "lead_gen" });
    await patch({ business_type: "ecommerce" });
    const { targets } = await (await getTargets(req("/x"), p)).json();
    expect(Object.keys(targets).sort()).toEqual([...METRIC_KEYS].sort());
    expect(targets.ctr).toEqual({ min: 3, max: null });
  });
  it("member gets 403, signed out 401, invalid type or extra keys 400", async () => {
    state.user = UA_MEMBER;
    expect((await patch({ business_type: "lead_gen" })).status).toBe(403);
    state.user = null;
    expect((await patch({ business_type: "lead_gen" })).status).toBe(401);
    state.user = UA_OWNER;
    for (const b of [{}, { business_type: "retail" }, { business_type: "lead_gen", name: "x" }, { business_type: "lead_gen", tenant_id: CB }, "x"]) {
      expect((await patch(b)).status, JSON.stringify(b)).toBe(400);
    }
    expect(db.rows("clients").find((c) => c.id === CA)!.business_type).toBeUndefined();
  });
  it("agency B's client is 404 for agency A and stays untouched", async () => {
    const res = await patch({ business_type: "lead_gen" }, CB);
    expect(res.status).toBe(404);
    expect(db.rows("clients").find((c) => c.id === CB)!.business_type).toBeUndefined();
    expect(db.rows("targets").filter((t) => t.client_id === CB)).toHaveLength(1);
  });
  it("an existing site's conversion events follow the new type", async () => {
    db.rows("sites").push({ id: "s1", client_id: CA, site_key: "k", allowed_origins: [], conversion_events: ["purchase", "form_submit"] });
    await patch({ business_type: "lead_gen" });
    expect(db.rows("sites")[0].conversion_events).toEqual(["lead", "form_submit"]);
    await patch({ business_type: "saas_b2b" });
    expect(db.rows("sites")[0].conversion_events).toEqual(["signup", "demo_booked", "paid"]);
    await patch({ business_type: "ecommerce" });
    expect(db.rows("sites")[0].conversion_events).toEqual(["purchase", "form_submit"]);
  });
});

describe("site creation by business type", () => {
  it.each([["lead_gen", ["lead", "form_submit"]], ["saas_b2b", ["signup", "demo_booked", "paid"]], ["ecommerce", ["purchase", "form_submit"]]] as const)(
    "%s gets sensible conversion events", async (bt, expected) => {
      setType(CA, bt);
      const res = await postSite(req("/x", { method: "POST", body: { allowed_origins: ["https://a.example"] } }), params({ clientId: CA }));
      expect(res.status).toBe(201);
      expect(db.rows("sites")[0].conversion_events).toEqual(expected);
    });
});

describe("performance route by business type", () => {
  const perfRow = { id: "c1", name: "Camp", spend: 100, impressions: 10000, link_clicks: 200, landing_page_views: 100, add_to_cart: 0, purchases: 0, purchase_value: 0, leads: 8 };
  const get = (id = CA) => getPerf(req(`/api/clients/${id}/performance?from=2026-11-01&to=2026-11-07&level=campaign`), params({ clientId: id }));
  it("lead_gen returns lead rows with cpl and lead_rate and no ecommerce rates", async () => {
    setType(CA, "lead_gen");
    hub.callTool.mockResolvedValue({ currency: "INR", rows: [perfRow] });
    const body = await (await get()).json();
    expect(body.business_type).toBe("lead_gen");
    expect(Object.keys(body.rows[0].rates).sort()).toEqual(["cpc", "cpl", "cpm", "ctr", "lead_rate"]);
    expect(body.rows[0].rates.cpl).toBeCloseTo(12.5);
    expect(Object.keys(body.totals.rates).sort()).toEqual(["cpc", "cpl", "cpm", "ctr", "lead_rate"]);
    expect(body.totals.rates.lead_rate).toBeCloseTo(4);
  });
  it("saas_b2b with a site uses ads_performance and tracked event counts", async () => {
    setType(CA, "saas_b2b");
    db.rows("sites").push({ id: "s1", client_id: CA, site_key: "k" });
    hub.callTool.mockResolvedValue({
      currency: "INR",
      rows: [{ ...perfRow, signup_sessions: 10, trial_sessions: 5, demo_sessions: 4, lead_sessions: 0, paid_events: 2 }],
      unattributed: { sessions: 1, signup_sessions: 1 },
    });
    const body = await (await get()).json();
    expect(hub.callTool.mock.calls[0][1]).toBe("ads_performance");
    expect(body.business_type).toBe("saas_b2b");
    expect(body.totals.rates.cac).toBeCloseTo(50);
    expect(body.totals.rates.cost_per_trial).toBeCloseTo(20);
    expect(body.rows[0].rates.demo_rate).toBeCloseTo(2);
    expect(body.unattributed.signup_sessions).toBe(1);
  });
  it("saas_b2b without a site: demo_rate, cost_per_trial and cac are null", async () => {
    setType(CA, "saas_b2b");
    hub.callTool.mockResolvedValue({ currency: "INR", rows: [perfRow] });
    const body = await (await get()).json();
    expect(body.rows[0].rates.demo_rate).toBeNull();
    expect(body.rows[0].rates.cac).toBeNull();
    expect(body.rows[0].rates.cpl).toBeCloseTo(12.5);
  });
  it("an ecommerce client is unchanged and agency B's client is still 404", async () => {
    hub.callTool.mockResolvedValue({ currency: "INR", rows: [{ ...perfRow, purchase_value: 500 }] });
    const body = await (await get()).json();
    expect(body.business_type).toBe("ecommerce");
    expect(Object.keys(body.rows[0].rates).sort()).toEqual([...METRIC_KEYS].sort());
    expect((await get(CB)).status).toBe(404);
  });
});
