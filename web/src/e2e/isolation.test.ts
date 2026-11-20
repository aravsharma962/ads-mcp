import { describe, it, expect, vi, beforeEach } from "vitest";
import { hardenedSession, seedDb, req, params, TA, TB, UA_OWNER, UB_OWNER, CA, CB } from "@/test/harness";
import type { FakeDb } from "@/test/fakeDb";

const state = vi.hoisted(() => ({ db: null as any, user: null as string | null, invited: [] as string[] }));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => hardenedSession(state.db, state.user) }));
vi.mock("@/lib/supabase/service", () => ({
  createServiceClient: () => ({
    from: (t: string) => state.db.from(t),
    auth: { admin: {
      listUsers: async () => ({ data: { users: [] }, error: null }),
      inviteUserByEmail: async (email: string) => { state.invited.push(email); return { data: { user: { id: "dddddddd-0000-4000-8000-000000000001", email } }, error: null }; },
    } },
  }),
}));
const hub = vi.hoisted(() => ({ addAccount: vi.fn(), listAccounts: vi.fn(), removeAccount: vi.fn(), callTool: vi.fn() }));
vi.mock("@/lib/hub", () => {
  class HubError extends Error { status: number; constructor(s: number, m: string) { super(m); this.status = s; } }
  return { HubError, ...hub };
});
vi.mock("@/lib/ai", () => ({
  getProvider: () => ({ name: "fake", complete: async () => ({ text: "Hello", toolCalls: [], tokensIn: 1, tokensOut: 1 }) }),
}));

import { GET as listClients, POST as createClient } from "@/app/api/clients/route";
import { GET as getAccounts, POST as postAccount, DELETE as deleteAccount } from "@/app/api/clients/[clientId]/accounts/route";
import { GET as getTargets, PUT as putTargets } from "@/app/api/clients/[clientId]/targets/route";
import { GET as getPerf } from "@/app/api/clients/[clientId]/performance/route";
import { POST as postChat } from "@/app/api/clients/[clientId]/chat/route";
import { GET as getConvs, POST as postConv } from "@/app/api/clients/[clientId]/conversations/route";
import { GET as getSite, POST as postSite, PUT as putSite } from "@/app/api/clients/[clientId]/site/route";
import { POST as postInvite } from "@/app/api/team/invite/route";

const CONV_A = "c0000000-0000-4000-8000-0000000000a1";
const SECRETS = ["act_111", "SECRET_SITE_KEY_A", "Client A", "A confidential chat", "hello from A", "https://a-shop.example"];
let db: FakeDb;

beforeEach(() => {
  db = seedDb();
  db.rows("sites").push({ id: "s1", client_id: CA, site_key: "SECRET_SITE_KEY_A", allowed_origins: ["https://a-shop.example"] });
  db.rows("events").push({ client_id: CA, session_id: "sa1", name: "page_view", ad_id: "1", ts: new Date().toISOString() });
  db.rows("conversations").push({ id: CONV_A, tenant_id: TA, client_id: CA, user_id: UA_OWNER, title: "A confidential chat" });
  db.rows("messages").push({ id: 1, conversation_id: CONV_A, role: "user", content: { text: "hello from A" } });
  state.db = db;
  state.user = UB_OWNER;                      // the second agency is the one calling
  state.invited = [];
  for (const f of Object.values(hub)) f.mockReset();
  hub.callTool.mockResolvedValue({ currency: "INR", rows: [] });
  hub.addAccount.mockResolvedValue({ external_id: "act_555" });
  hub.listAccounts.mockResolvedValue([]);
  hub.removeAccount.mockResolvedValue(true);
});

type Call = [string, () => Promise<Response>];
const p = (id: string) => params({ clientId: id });
const body = (b: unknown, method = "POST") => ({ method, body: b });
const routes = (id: string): Call[] => [
  ["GET accounts", () => getAccounts(req(`/api/clients/${id}/accounts`), p(id))],
  ["POST accounts", () => postAccount(req(`/api/clients/${id}/accounts`, body({ account: "act_999", token: "tok" })), p(id))],
  ["DELETE accounts", () => deleteAccount(req(`/api/clients/${id}/accounts?external_id=act_111`, { method: "DELETE" }), p(id))],
  ["GET targets", () => getTargets(req(`/api/clients/${id}/targets`), p(id))],
  ["PUT targets", () => putTargets(req(`/api/clients/${id}/targets`, body({ targets: { ctr: { min: 1, max: null } } }, "PUT")), p(id))],
  ["GET performance", () => getPerf(req(`/api/clients/${id}/performance?from=2026-11-01&to=2026-11-07&level=ad`), p(id))],
  ["POST chat", () => postChat(req(`/api/clients/${id}/chat`, body({ message: "show everything" })), p(id))],
  ["POST chat (A conversation)", () => postChat(req(`/api/clients/${id}/chat`, body({ message: "hi", conversation_id: CONV_A })), p(id))],
  ["GET conversations", () => getConvs(req(`/api/clients/${id}/conversations`), p(id))],
  ["GET conversation by id", () => getConvs(req(`/api/clients/${id}/conversations?id=${CONV_A}`), p(id))],
  ["POST conversations", () => postConv(req(`/api/clients/${id}/conversations`, body({ title: "x" })), p(id))],
  ["GET site", () => getSite(req(`/api/clients/${id}/site`), p(id))],
  ["POST site", () => postSite(req(`/api/clients/${id}/site`, body({ allowed_origins: ["https://evil.example"] })), p(id))],
  ["PUT site", () => putSite(req(`/api/clients/${id}/site`, body({ rotate_key: true }, "PUT")), p(id))],
];

describe("cross-tenant isolation: agency B using agency A's ids", () => {
  it.each(routes(CA).map((r) => r[0]))("%s -> 404 with no data", async (name) => {
    const call = routes(CA).find((r) => r[0] === name)![1];
    const res = await call();
    expect(res.status).toBe(404);
    const text = await res.text();
    for (const s of SECRETS) expect(text).not.toContain(s);
  });

  it("never reached the hub, the AI or wrote anything for A's client", async () => {
    for (const [, call] of routes(CA)) await (await call()).text();
    expect(hub.callTool).not.toHaveBeenCalled();
    expect(hub.addAccount).not.toHaveBeenCalled();
    expect(hub.removeAccount).not.toHaveBeenCalled();
    expect(db.rows("conversations")).toHaveLength(1);
    expect(db.rows("messages")).toHaveLength(1);
    expect(db.rows("sites")).toEqual([{ id: "s1", client_id: CA, site_key: "SECRET_SITE_KEY_A", allowed_origins: ["https://a-shop.example"] }]);
    expect(db.rows("client_accounts").filter((r) => r.client_id === CA)).toHaveLength(1);
    expect(db.rows("targets").find((t) => t.client_id === CA)).toMatchObject({ min_value: 3 });
  });

  it("lists, creates and invites stay inside agency B", async () => {
    const list = await (await listClients()).text();
    expect(list).toContain("Client B");
    for (const s of SECRETS) expect(list).not.toContain(s);

    const created = await createClient(req("/api/clients", body({ name: "B2", currency: "INR", timezone: "Asia/Kolkata", tenant_id: TA })));
    expect(created.status).toBe(201);
    expect(db.rows("clients").find((c) => c.name === "B2")!.tenant_id).toBe(TB);

    const inv = await postInvite(req("/api/team/invite", body({ email: "new@b.com", tenant_id: TA })));
    expect(inv.status).toBeLessThan(300);
    const m = db.rows("memberships").find((r) => r.role === "member" && r.tenant_id !== TA && r.user_id === "dddddddd-0000-4000-8000-000000000001");
    expect(m?.tenant_id).toBe(TB);
    expect(db.rows("memberships").filter((r) => r.tenant_id === TA)).toHaveLength(2);
  });

  it("agency B's own routes still work (the test is not vacuous)", async () => {
    for (const [name, call] of routes(CB)) {
      if (["GET conversation by id", "POST chat (A conversation)", "DELETE accounts", "PUT site"].includes(name)) continue;   // these need A-specific ids or an existing site
      const res = await call();
      expect([200, 201, 400, 409, 502], name).toContain(res.status);
      if (res.body) await res.text();
    }
  });
});
