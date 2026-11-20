import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { seedDb, UA_OWNER, UA_MEMBER } from "@/test/harness";
import type { FakeDb } from "@/test/fakeDb";

const state = vi.hoisted(() => ({ db: null as any, user: null as string | null }));
const EMAILS: Record<string, string> = {
  "aaaaaaaa-0000-4000-8000-000000000001": "a-owner@agency-a.com",
  "aaaaaaaa-0000-4000-8000-000000000002": "a-member@agency-a.com",
  "bbbbbbbb-0000-4000-8000-000000000001": "b-owner@agency-b.com",
};
// Session client behaves like RLS: memberships only shows the caller's own row.
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: state.user ? { id: state.user } : null }, error: null }) },
    from: (t: string) => {
      const q = state.db.from(t);
      return t === "memberships" ? q.eq("user_id", state.user) : q;
    },
  }),
}));
vi.mock("@/lib/supabase/service", () => ({
  createServiceClient: () => ({
    from: (t: string) => state.db.from(t),
    auth: { admin: { getUserById: async (id: string) => ({ data: { user: { email: EMAILS[id] } } }) } },
  }),
}));
vi.mock("@/components/InviteForm", () => ({ default: () => null }));

import TeamPage from "./(app)/settings/team/page";

let db: FakeDb;
beforeEach(() => { db = seedDb(); state.db = db; state.user = UA_OWNER; });

describe("team page", () => {
  it("lists every member of the owner's tenant (service role, filtered by session tenant) and nobody else", async () => {
    const html = renderToStaticMarkup(await TeamPage());
    expect(html).toContain("a-owner@agency-a.com");
    expect(html).toContain("a-member@agency-a.com");
    expect(html).not.toContain("b-owner@agency-b.com");
  });
  it("a member gets notFound", async () => {
    state.user = UA_MEMBER;
    await expect(TeamPage()).rejects.toThrow();
  });
});
