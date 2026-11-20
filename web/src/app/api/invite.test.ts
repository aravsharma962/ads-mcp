import { describe, it, expect, vi, beforeEach } from "vitest";
import { seedDb, req, UA_OWNER, UA_MEMBER, UB_OWNER, TA, TB } from "@/test/harness";
import type { FakeDb } from "@/test/fakeDb";

const state = vi.hoisted(() => ({ db: null as any, user: null as string | null, authUsers: [] as { id: string; email: string }[], invited: [] as string[] }));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => state.db.session(state.user) }));
vi.mock("@/lib/supabase/service", () => ({
  createServiceClient: () => ({
    from: (t: string) => state.db.from(t),
    auth: {
      admin: {
        listUsers: async ({ page = 1, perPage = 50 }: { page?: number; perPage?: number } = {}) => ({
          data: { users: state.authUsers.slice((page - 1) * perPage, page * perPage) }, error: null,
        }),
        inviteUserByEmail: async (email: string) => {
          state.invited.push(email);
          const u = { id: `dddddddd-0000-4000-8000-${String(state.authUsers.length + 1).padStart(12, "0")}`, email };
          state.authUsers.push(u);
          return { data: { user: u }, error: null };
        },
      },
    },
  }),
}));

import { POST } from "./team/invite/route";

let db: FakeDb;
beforeEach(() => {
  db = seedDb();
  state.db = db;
  state.user = UA_OWNER;
  state.authUsers = [
    { id: UB_OWNER, email: "b-owner@agency-b.com" },
    { id: UA_OWNER, email: "a-owner@agency-a.com" },
  ];
  state.invited = [];
  process.env.APP_URL = "https://app.example";
});
const invite = (body: unknown) => POST(req("/api/team/invite", { method: "POST", body }));

describe("POST /api/team/invite", () => {
  it("member cannot invite: 403", async () => {
    state.user = UA_MEMBER;
    expect((await invite({ email: "new@x.com" })).status).toBe(403);
    expect(state.invited).toEqual([]);
  });
  it("signed out: 401", async () => {
    state.user = null;
    expect((await invite({ email: "new@x.com" })).status).toBe(401);
  });
  it("owner invite creates a member membership for the owner's tenant, ignoring body tenant id and role", async () => {
    const res = await invite({ email: "New@X.com", tenant_id: TB, role: "owner" });
    expect(res.status).toBe(201);
    expect(state.invited).toEqual(["new@x.com"]);
    const m = db.rows("memberships").filter((r) => r.user_id.startsWith("dddddddd"));
    expect(m).toHaveLength(1);
    expect(m[0]).toMatchObject({ tenant_id: TA, role: "member" });
    expect(db.rows("memberships").some((r) => r.tenant_id === TB && r.user_id.startsWith("dddddddd"))).toBe(false);
  });
  it("email that belongs to another agency: 409 English message, nothing changed", async () => {
    const before = db.rows("memberships").length;
    const res = await invite({ email: "b-owner@agency-b.com" });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("This email cannot be invited.");
    expect(db.rows("memberships")).toHaveLength(before);
    expect(state.invited).toEqual([]);
  });
  it("email already in this agency: 409", async () => {
    const res = await invite({ email: "a-owner@agency-a.com" });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("This email cannot be invited.");
  });
  it("existing auth user without membership is NOT attached (neutral refusal, no invite, no membership)", async () => {
    state.authUsers.push({ id: "eeeeeeee-0000-4000-8000-000000000001", email: "free@x.com" });
    const before = db.rows("memberships").length;
    const res = await invite({ email: "free@x.com" });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("This email cannot be invited.");
    expect(state.invited).toEqual([]);
    expect(db.rows("memberships")).toHaveLength(before);
  });
  it("invalid email: 400", async () => {
    expect((await invite({ email: "nope" })).status).toBe(400);
    expect((await invite({})).status).toBe(400);
  });
  it("finds existing users on later pages", async () => {
    for (let i = 0; i < 120; i++) state.authUsers.push({ id: `ffffffff-0000-4000-8000-${String(i).padStart(12, "0")}`, email: `u${i}@x.com` });
    db.rows("memberships").push({ user_id: "ffffffff-0000-4000-8000-000000000119", tenant_id: TB, role: "member" });
    expect((await invite({ email: "u119@x.com" })).status).toBe(409);
  });
});
