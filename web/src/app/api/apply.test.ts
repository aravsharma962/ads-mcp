import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { seedDb, req, params, UA_OWNER, UA_MEMBER, CA, CB } from "@/test/harness";
import type { FakeDb } from "@/test/fakeDb";

const state = vi.hoisted(() => ({ db: null as any, user: null as string | null }));
// The signed-in (authenticated) client can read action_log but cannot write it: RLS has no insert/update/delete policy.
const guarded = (s: any) => ({
  ...s,
  from: (t: string) => {
    const q = s.from(t);
    if (t !== "action_log") return q;
    const deny: any = new Proxy({}, { get: (_x, k) => (k === "then" ? (res: any) => Promise.resolve({ data: null, error: { message: "permission denied" } }).then(res) : () => deny) });
    for (const m of ["insert", "update", "delete", "upsert"]) q[m] = () => deny;
    return q;
  },
});
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => guarded(state.db.session(state.user)) }));
vi.mock("@/lib/supabase/service", () => ({ createServiceClient: () => state.db.session(null) }));
const hub = vi.hoisted(() => ({ callTool: vi.fn() }));
vi.mock("@/lib/hub", () => {
  class HubError extends Error {
    status: number;
    constructor(status: number, m: string) { super(m); this.status = status; }
  }
  return { HubError, callTool: hub.callTool };
});

import { GET as applyGet, POST as applyPost } from "./clients/[clientId]/apply/route";

let db: FakeDb;
const NOT_ENABLED = "Changes in Meta are not enabled on this platform yet.";
const HUB_NOT_ENABLED = "Changes in Meta are not enabled on this platform.";
const adRow = (o: Record<string, unknown> = {}) => ({
  id: "a1", name: "Ad 1", campaign_id: "c1", adset_id: "s1", ad_id: "a1", thumbnail_url: null,
  spend: 1000, impressions: 20000, link_clicks: 400, landing_page_views: 300, add_to_cart: 50, purchases: 20, purchase_value: 8000,
  ctr: 2, cpc: 2.5, cpm: 50, roas: 8, frequency: 1.5, reach: 13000, ...o,
});
// Verdict "scale": plenty of results at a very cheap cost. Verdict "pause": spend with no results.
const SCALE = adRow({ purchase_value: 12000 });   // ROAS 12 meets the default target (min 9)
const PAUSE = adRow({ purchases: 0, purchase_value: 0, add_to_cart: 0, landing_page_views: 0, roas: 0, reach: 5000, frequency: 4 });
const PAUSE_PREV = adRow({ link_clicks: 800 });   // CTR halves, frequency high, no results: all three signals -> pause
const FILLER = adRow({ id: "b", ad_id: "b", name: "Ad B", adset_id: "s2", spend: 5000, purchases: 5 }); // lifts the account average cost
const KEEP = adRow({ impressions: 10 });

let recentRows: unknown[];
let previousRows: unknown[];
let writes: any;
let sent: any[];
afterEach(() => { delete process.env.META_WRITES_ENABLED; });
const setPerf = (row: Record<string, unknown>, prev: Record<string, unknown> = row === PAUSE ? PAUSE_PREV : row) => {
  recentRows = [row, FILLER];
  previousRows = [prev, FILLER];
};
const post = (body: unknown, id = CA) => applyPost(req(`/api/clients/${id}/apply`, { method: "POST", body }), params({ clientId: id }));
const get = (id = CA) => applyGet(req(`/api/clients/${id}/apply`), params({ clientId: id }));
const logs = () => db.rows("action_log");
const writeCalls = () => hub.callTool.mock.calls.filter((c) => c[1] === "meta_set_status" || c[1] === "meta_raise_budget");
const seedLog = (o: Record<string, unknown>) =>
  logs().push({ id: crypto.randomUUID(), client_id: CA, tenant_id: "t", user_id: UA_OWNER, ad_id: "a1", ad_name: "Ad 1", action: "pause", level: "ad", object_id: "a1", before: {}, after: {}, status: "ok", error: null, created_at: new Date().toISOString(), ...o });
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();

beforeEach(() => {
  db = seedDb();
  db.tables.targets = [];   // no custom targets
  db.rows("clients").forEach((c) => (c.roas_source = "meta"));   // no tracker site: ROAS comes from Meta
  state.db = db;
  state.user = UA_OWNER;
  process.env.META_WRITES_ENABLED = "1";
  sent = [];
  db.hooks.action_log = (row, rows) => {
    sent.push({ ...row });
    row.created_at ??= new Date().toISOString();   // DB default
    if (row.status === "pending" && rows.some((r) => r.status === "pending" && r.client_id === row.client_id && r.object_id === row.object_id)) {
      return { message: "duplicate key value violates unique constraint \"action_log_pending_uq\"", code: "23505" };
    }
    return null;
  };
  setPerf(SCALE);
  writes = vi.fn();
  hub.callTool.mockReset().mockImplementation(async (_t: string, name: string, args: any) => {
    if (name === "ads_performance" || name === "meta_ads_insights") {
      const recent = Date.parse(args.date_from) > Date.now() - 10 * 86_400_000;
      return { currency: "INR", rows: recent ? recentRows : previousRows };
    }
    return writes(name, args);
  });
  writes.mockImplementation((name: string) =>
    name === "meta_set_status"
      ? { before: { status: "ACTIVE" }, after: { status: "PAUSED" } }
      : { before: { daily_budget: 1000 }, after: { daily_budget: 1200 } });
});

describe("POST apply: access and input", () => {
  it("401 signed out, 404 foreign client, 403 member, 400 bad body; hub never written", async () => {
    state.user = null;
    expect((await post({ ad_id: "a1", action: "scale" })).status).toBe(401);
    state.user = UA_OWNER;
    expect((await post({ ad_id: "a1", action: "scale" }, CB)).status).toBe(404);
    state.user = UA_MEMBER;
    const r = await post({ ad_id: "a1", action: "scale" });
    expect(r.status).toBe(403);
    expect((await r.json()).error).toMatch(/owner/i);
    state.user = UA_OWNER;
    expect((await post({ ad_id: "a1", action: "delete" })).status).toBe(400);
    expect((await post({ action: "pause" })).status).toBe(400);
    expect((await post("nope")).status).toBe(400);
    expect(writeCalls()).toHaveLength(0);
    expect(logs()).toHaveLength(0);
  });
  it("404 for an ad that is not in the client's list", async () => {
    const r = await post({ ad_id: "zzz", action: "pause" });
    expect(r.status).toBe(404);
    expect(writeCalls()).toHaveLength(0);
  });
  it("hub failure while loading data is a plain 502", async () => {
    hub.callTool.mockRejectedValue(new Error("Traceback secret"));
    const r = await post({ ad_id: "a1", action: "pause" });
    expect(r.status).toBe(502);
    expect(JSON.stringify(await r.json())).not.toContain("Traceback");
  });
});

describe("POST apply: pause", () => {
  it("pauses when the server verdict is pause, using the ad's account, and logs ok", async () => {
    setPerf(PAUSE);
    const r = await post({ ad_id: "a1", action: "pause", verdict: "scale" });
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body).toMatchObject({ ok: true, action: "pause", ad_id: "a1", level: "ad", object_id: "a1", after: { status: "PAUSED" } });
    expect(body.note).toMatch(/paused/i);
    expect(writes).toHaveBeenCalledWith("meta_set_status", { external_id: "act_111", object_id: "a1", level: "ad", status: "PAUSED" });
    expect(hub.callTool.mock.calls.find((c) => c[1] === "meta_set_status")![0]).toBe("11111111-1111-4111-8111-111111111111");
    expect(logs()).toHaveLength(1);
    expect(logs()[0]).toMatchObject({ client_id: CA, tenant_id: "11111111-1111-4111-8111-111111111111", user_id: UA_OWNER, ad_id: "a1", ad_name: "Ad 1", action: "pause", level: "ad", object_id: "a1", status: "ok", error: null });
    expect(logs()[0].before).toEqual({ status: "ACTIVE" });
  });
  it("refuses when the server verdict is not pause (browser claim ignored)", async () => {
    setPerf(SCALE);
    const r = await post({ ad_id: "a1", action: "pause", verdict: "pause" });
    expect(r.status).toBe(409);
    expect(writeCalls()).toHaveLength(0);
  });
  it("refuses a second pause of an ad whose last ok change was a pause", async () => {
    setPerf(PAUSE);
    seedLog({ action: "pause", created_at: daysAgo(1) });
    expect((await post({ ad_id: "a1", action: "pause" })).status).toBe(409);
    expect(writeCalls()).toHaveLength(0);
  });
});

describe("POST apply: scale", () => {
  it("raises the ad set budget by 20% and logs level adset", async () => {
    const r = await post({ ad_id: "a1", action: "scale" });
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body).toMatchObject({ action: "scale", level: "adset", object_id: "s1", before: { daily_budget: 1000 }, after: { daily_budget: 1200 } });
    expect(body.note).toBe("Ad set budget raised from 1,000 to 1,200 (+20%).");
    expect(writes).toHaveBeenCalledWith("meta_raise_budget", { external_id: "act_111", object_id: "s1", level: "adset", percent: 20 });
    expect(logs()[0]).toMatchObject({ action: "scale", level: "adset", object_id: "s1", status: "ok" });
  });
  it("refuses when the server verdict is not scale", async () => {
    setPerf(KEEP);
    const r = await post({ ad_id: "a1", action: "scale" });
    expect(r.status).toBe(409);
    expect(writeCalls()).toHaveLength(0);
  });
  it("cooldown: a second scale on the same ad set within 3 days is refused (double submit)", async () => {
    expect((await post({ ad_id: "a1", action: "scale" })).status).toBe(200);
    const r2 = await post({ ad_id: "a1", action: "scale" });
    expect(r2.status).toBe(409);
    expect((await r2.json()).error).toMatch(/3 days|wait/i);
    expect(writeCalls()).toHaveLength(1);
  });
  it("cooldown applies per object, shared by sibling ads in the same ad set", async () => {
    seedLog({ ad_id: "other", action: "scale", level: "adset", object_id: "s1", created_at: daysAgo(1) });
    expect((await post({ ad_id: "a1", action: "scale" })).status).toBe(409);
  });
  it("allows scale again after 3 days; a failed attempt does not start a cooldown", async () => {
    seedLog({ action: "scale", level: "adset", object_id: "s1", created_at: daysAgo(4) });
    seedLog({ action: "scale", level: "adset", object_id: "s1", status: "error", error: "x", created_at: daysAgo(0.1) });
    expect((await post({ ad_id: "a1", action: "scale" })).status).toBe(200);
  });
  it("two concurrent submits raise the budget once", async () => {
    const [a, b] = await Promise.all([post({ ad_id: "a1", action: "scale" }), post({ ad_id: "a1", action: "scale" })]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    expect(writeCalls()).toHaveLength(1);
  });
  it("budget_not_here on the ad set retries once on the campaign", async () => {
    writes.mockImplementation((name: string, args: any) => {
      if (args.level === "adset") throw new Error("budget_not_here: this ad set has no daily budget of its own.");
      return { before: { daily_budget: 5000 }, after: { daily_budget: 6000 } };
    });
    const r = await post({ ad_id: "a1", action: "scale" });
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body).toMatchObject({ level: "campaign", object_id: "c1" });
    expect(body.note).toMatch(/^Campaign budget raised from 5,000 to 6,000 \(\+20%\)\.$/);
    expect(writeCalls().map((c) => c[2].level)).toEqual(["adset", "campaign"]);
    expect(logs()).toHaveLength(1);
    expect(logs()[0]).toMatchObject({ level: "campaign", object_id: "c1", status: "ok" });
  });
  it("budget_not_here on both levels is a 409 with the plain message and an error log", async () => {
    writes.mockImplementation(() => { throw new Error("budget_not_here: this object has a lifetime budget."); });
    const r = await post({ ad_id: "a1", action: "scale" });
    expect(r.status).toBe(409);
    const msg = (await r.json()).error as string;
    expect(msg).toMatch(/lifetime budget/);
    expect(msg).not.toMatch(/budget_not_here/);
    expect(writeCalls()).toHaveLength(2);
    expect(logs()).toHaveLength(1);
    expect(logs()[0]).toMatchObject({ status: "error", action: "scale" });
  });
  it("scales the campaign directly when the ad has no ad set id", async () => {
    setPerf({ ...SCALE, adset_id: null });
    await post({ ad_id: "a1", action: "scale" });
    expect(writeCalls().map((c) => c[2].level)).toEqual(["campaign"]);
  });
});

describe("POST apply: resume", () => {
  it("resumes only when the latest ok log for the ad is a pause, on the paused object", async () => {
    setPerf(KEEP);
    seedLog({ action: "pause", level: "ad", object_id: "a1", created_at: daysAgo(2) });
    writes.mockReturnValue({ before: { status: "PAUSED" }, after: { status: "ACTIVE" } });
    const r = await post({ ad_id: "a1", action: "resume" });
    expect(r.status).toBe(200);
    expect(writes).toHaveBeenCalledWith("meta_set_status", { external_id: "act_111", object_id: "a1", level: "ad", status: "ACTIVE" });
    expect(logs().at(-1)).toMatchObject({ action: "resume", status: "ok" });
  });
  it("refuses with no log, with an error-only log, or when already resumed", async () => {
    setPerf(KEEP);
    expect((await post({ ad_id: "a1", action: "resume" })).status).toBe(409);
    seedLog({ action: "pause", status: "error", error: "x", created_at: daysAgo(2) });
    expect((await post({ ad_id: "a1", action: "resume" })).status).toBe(409);
    seedLog({ action: "pause", created_at: daysAgo(3) });
    seedLog({ action: "resume", created_at: daysAgo(1) });
    expect((await post({ ad_id: "a1", action: "resume" })).status).toBe(409);
    expect(writeCalls()).toHaveLength(0);
  });
  it("ignores another client's log for the same ad id", async () => {
    setPerf(KEEP);
    seedLog({ client_id: CB, action: "pause" });
    expect((await post({ ad_id: "a1", action: "resume" })).status).toBe(409);
  });
});

describe("POST apply: hub errors", () => {
  beforeEach(() => setPerf(PAUSE));
  it.each([HUB_NOT_ENABLED])("hub string %s -> 409 not enabled, error logged", async (m) => {
    writes.mockImplementation(() => { throw new Error(m); });
    const r = await post({ ad_id: "a1", action: "pause" });
    expect(r.status).toBe(409);
    expect((await r.json()).error).toBe(NOT_ENABLED);
    expect(logs()[0]).toMatchObject({ status: "error", error: NOT_ENABLED, action: "pause", level: "ad", object_id: "a1" });
  });
  it("permission error -> 409 with the permission message", async () => {
    writes.mockImplementation(() => { throw new Error("permission: the connected token cannot change ads (ads_management is missing)."); });
    const r = await post({ ad_id: "a1", action: "pause" });
    expect(r.status).toBe(409);
    expect((await r.json()).error).toMatch(/ads_management/);
    expect(logs()[0].status).toBe("error");
  });
  it("other hub failure -> 502 without internals, error logged", async () => {
    writes.mockImplementation(() => { throw new Error("Traceback: boom EAAxxxxxxxxxxxxxxxx"); });
    const r = await post({ ad_id: "a1", action: "pause" });
    expect(r.status).toBe(502);
    expect(JSON.stringify(await r.json())).not.toMatch(/Traceback|EAA/);
    expect(logs()).toHaveLength(1);
    expect(JSON.stringify(logs()[0])).not.toMatch(/Traceback|EAA/);
    expect(logs()[0].status).toBe("error");
  });
  it("with several accounts, tries the next one when the hub refuses the object", async () => {
    db.rows("client_accounts").push({ client_id: CA, platform: "meta", external_id: "act_222" });
    writes.mockImplementation((_n: string, args: any) => {
      if (args.external_id === "act_111") throw new Error("Object does not belong to this account.");
      return { before: { status: "ACTIVE" }, after: { status: "PAUSED" } };
    });
    const r = await post({ ad_id: "a1", action: "pause" });
    expect(r.status).toBe(200);
    expect(writeCalls().map((c) => c[2].external_id)).toEqual(["act_111", "act_222"]);
    expect(logs()).toHaveLength(1);
  });
});

describe("GET apply", () => {
  it("returns the last 50 log rows of this client, newest first, writes_enabled true", async () => {
    for (let i = 0; i < 55; i++) seedLog({ created_at: new Date(Date.UTC(2026, 10, 1, 0, i)).toISOString() });
    seedLog({ client_id: CB });
    const r = await get();
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.log).toHaveLength(50);
    expect(body.log[0].created_at > body.log[49].created_at).toBe(true);
    expect(body.writes_enabled).toBe(true);
    expect(body.log[0]).not.toHaveProperty("tenant_id");
  });
  it("writes_enabled comes from META_WRITES_ENABLED, not from the log", async () => {
    seedLog({ status: "error", error: NOT_ENABLED, created_at: daysAgo(1) });
    expect((await (await get()).json()).writes_enabled).toBe(true);
    process.env.META_WRITES_ENABLED = "0";
    expect((await (await get()).json()).writes_enabled).toBe(false);
    delete process.env.META_WRITES_ENABLED;
    expect((await (await get()).json()).writes_enabled).toBe(false);
  });
  it("members can read; foreign client 404; signed out 401; hub untouched", async () => {
    state.user = UA_MEMBER;
    expect((await get()).status).toBe(200);
    expect((await get(CB)).status).toBe(404);
    state.user = null;
    expect((await get()).status).toBe(401);
    expect(hub.callTool).not.toHaveBeenCalled();
  });
});

describe("POST apply: writes switch", () => {
  it.each([undefined, "0", "true"])("META_WRITES_ENABLED=%s -> 409 before any hub call, nothing logged", async (v) => {
    if (v === undefined) delete process.env.META_WRITES_ENABLED; else process.env.META_WRITES_ENABLED = v;
    setPerf(PAUSE);
    const r = await post({ ad_id: "a1", action: "pause" });
    expect(r.status).toBe(409);
    expect((await r.json()).error).toBe(NOT_ENABLED);
    expect(hub.callTool).not.toHaveBeenCalled();
    expect(logs()).toHaveLength(0);
  });
  it("a loose 'not enabled' text from the hub is not trusted as the switch: generic 502", async () => {
    setPerf(PAUSE);
    writes.mockImplementation(() => { throw new Error("Meta changes are not enabled."); });
    expect((await post({ ad_id: "a1", action: "pause" })).status).toBe(502);
  });
});

describe("action_log writes: service role only, atomic claim", () => {
  it("never sends created_at; first writes a pending row, ends with ok + before/after", async () => {
    setPerf(PAUSE);
    expect((await post({ ad_id: "a1", action: "pause" })).status).toBe(200);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ status: "pending", action: "pause", level: "ad", object_id: "a1", user_id: UA_OWNER });
    expect(sent[0]).not.toHaveProperty("created_at");
    expect(logs()).toHaveLength(1);
    expect(logs()[0]).toMatchObject({ status: "ok", before: { status: "ACTIVE" }, after: { status: "PAUSED" }, error: null });
  });
  it("the pending row exists while the hub call runs", async () => {
    setPerf(PAUSE);
    let seen: string[] = [];
    writes.mockImplementation(() => { seen = logs().map((r) => r.status); return { before: {}, after: {} }; });
    await post({ ad_id: "a1", action: "pause" });
    expect(seen).toEqual(["pending"]);
  });
  it("owner check comes first: a member writes nothing", async () => {
    setPerf(PAUSE);
    state.user = UA_MEMBER;
    expect((await post({ ad_id: "a1", action: "pause" })).status).toBe(403);
    expect(sent).toHaveLength(0);
  });
  it("a young pending row for the object blocks a pause: 409 in progress, hub untouched", async () => {
    setPerf(PAUSE);
    seedLog({ status: "pending", created_at: new Date(Date.now() - 30_000).toISOString() });
    const r = await post({ ad_id: "a1", action: "pause" });
    expect(r.status).toBe(409);
    expect((await r.json()).error).toBe("Another change to this ad or budget is in progress. Try again in a minute.");
    expect(writeCalls()).toHaveLength(0);
  });
  it("a unique violation at insert time is the same 409 (race across instances)", async () => {
    setPerf(PAUSE);
    db.hooks.action_log = () => ({ message: "duplicate key", code: "23505" });
    const r = await post({ ad_id: "a1", action: "pause" });
    expect(r.status).toBe(409);
    expect((await r.json()).error).toMatch(/in progress/);
    expect(writeCalls()).toHaveLength(0);
  });
  it("pending rows older than 2 minutes become unknown, and then count toward the scale cooldown", async () => {
    seedLog({ action: "scale", level: "adset", object_id: "s1", status: "pending", created_at: new Date(Date.now() - 3 * 60_000).toISOString() });
    const r = await post({ ad_id: "a1", action: "scale" });
    expect(r.status).toBe(409);
    expect(logs()[0].status).toBe("unknown");
    expect(writeCalls()).toHaveLength(0);
  });
  it("a young pending scale row counts toward the cooldown and stays pending", async () => {
    seedLog({ action: "scale", level: "adset", object_id: "s1", status: "pending", created_at: new Date(Date.now() - 20_000).toISOString() });
    expect((await post({ ad_id: "a1", action: "scale" })).status).toBe(409);
    expect(logs()[0].status).toBe("pending");
  });
  it("a stale pending row on the same object does not block a new claim", async () => {
    setPerf(PAUSE);
    seedLog({ action: "scale", level: "adset", object_id: "a1", status: "pending", created_at: new Date(Date.now() - 5 * 60_000).toISOString() });
    expect((await post({ ad_id: "a1", action: "pause" })).status).toBe(200);
  });
  it("the in-process lock is keyed by the target object: two ads in one ad set raise it once", async () => {
    setPerf(SCALE);
    recentRows = [SCALE, { ...SCALE, id: "a2", ad_id: "a2", name: "Ad 2" }, FILLER];
    previousRows = [SCALE, { ...SCALE, id: "a2", ad_id: "a2", name: "Ad 2" }, FILLER];
    const [x, y] = await Promise.all([post({ ad_id: "a1", action: "scale" }), post({ ad_id: "a2", action: "scale" })]);
    expect([x.status, y.status].sort()).toEqual([200, 409]);
    expect(writeCalls()).toHaveLength(1);
  });
  it("budget_not_here on the ad set leaves no stray pending row for it", async () => {
    writes.mockImplementation((_n: string, args: any) => {
      if (args.level === "adset") throw new Error("budget_not_here: x");
      return { before: { daily_budget: 5000 }, after: { daily_budget: 6000 } };
    });
    expect((await post({ ad_id: "a1", action: "scale" })).status).toBe(200);
    expect(logs().map((r) => [r.object_id, r.status])).toEqual([["c1", "ok"]]);
  });
});

describe("POST apply: unknown and unchanged hub outcomes", () => {
  it("unknown: -> 409 telling the owner to check Ads Manager, logged as unknown", async () => {
    setPerf(PAUSE);
    writes.mockImplementation(() => { throw new Error("unknown: the change was sent but Meta did not confirm."); });
    const r = await post({ ad_id: "a1", action: "pause" });
    expect(r.status).toBe(409);
    expect((await r.json()).error).toMatch(/Ads Manager/);
    expect(logs()).toHaveLength(1);
    expect(logs()[0].status).toBe("unknown");
    expect(writeCalls()).toHaveLength(1);   // no next account, no retry
  });
  it("an unknown scale counts toward the cooldown", async () => {
    writes.mockImplementation(() => { throw new Error("unknown: sent, outcome unclear"); });
    expect((await post({ ad_id: "a1", action: "scale" })).status).toBe(409);
    writes.mockClear();
    const r2 = await post({ ad_id: "a1", action: "scale" });
    expect(r2.status).toBe(409);
    expect((await r2.json()).error).toMatch(/3 days|wait/i);
    expect(writes).not.toHaveBeenCalled();
  });
  it("unchanged: -> 409 with the message minus the prefix, logged as error", async () => {
    setPerf(PAUSE);
    writes.mockImplementation(() => { throw new Error("unchanged: this ad is archived and cannot be changed."); });
    const r = await post({ ad_id: "a1", action: "pause" });
    expect(r.status).toBe(409);
    expect((await r.json()).error).toBe("this ad is archived and cannot be changed.");
    expect(logs()[0]).toMatchObject({ status: "error" });
  });
  it("resume is allowed when the latest pause is unknown", async () => {
    setPerf(KEEP);
    seedLog({ action: "pause", status: "unknown", created_at: daysAgo(1) });
    writes.mockReturnValue({ before: { status: "PAUSED" }, after: { status: "ACTIVE" } });
    expect((await post({ ad_id: "a1", action: "resume" })).status).toBe(200);
  });
  it("resume refuses a stored object_id that is not the ad's own id", async () => {
    setPerf(KEEP);
    seedLog({ action: "pause", level: "ad", object_id: "other-object", created_at: daysAgo(1) });
    expect((await post({ ad_id: "a1", action: "resume" })).status).toBe(409);
    expect(writeCalls()).toHaveLength(0);
  });
});
