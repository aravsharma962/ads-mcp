import { describe, it, expect, vi, beforeEach } from "vitest";

const { redirect } = vi.hoisted(() => ({
  redirect: vi.fn(),
}));
vi.mock("next/navigation", () => ({ redirect }));
vi.mock("next/headers", () => ({
  headers: async () => new Headers({ "x-tenant-id": "evil-tenant" }),
  cookies: async () => ({ get: () => ({ value: "evil-tenant" }), getAll: () => [] }),
}));

import { requireTenantContext, resolveTenantContext, NoTenantError, getMembership } from "./tenant";

function fakeSupabase(opts: { user: { id: string } | null; membership: { tenant_id: string; role: string } | null }) {
  const calls: { table: string; eq: [string, unknown][] }[] = [];
  return {
    calls,
    auth: { getUser: async () => ({ data: { user: opts.user }, error: null }) },
    from(table: string) {
      const call = { table, eq: [] as [string, unknown][] };
      calls.push(call);
      const b: any = {
        select: () => b,
        eq: (c: string, v: unknown) => (call.eq.push([c, v]), b),
        maybeSingle: async () => ({ data: opts.membership, error: null }),
      };
      return b;
    },
  };
}

beforeEach(() => {
  redirect.mockReset();
  redirect.mockImplementation((to: string) => {
    throw new Error(`NEXT_REDIRECT:${to}`);
  });
});

describe("requireTenantContext", () => {
  it("no session redirects to login", async () => {
    const sb = fakeSupabase({ user: null, membership: null });
    await expect(requireTenantContext(sb as any)).rejects.toThrow("NEXT_REDIRECT:/login");
    expect(redirect).toHaveBeenCalledWith("/login");
  });

  it("user without membership throws NoTenantError", async () => {
    const sb = fakeSupabase({ user: { id: "u1" }, membership: null });
    await expect(requireTenantContext(sb as any)).rejects.toBeInstanceOf(NoTenantError);
  });

  it("returns tenantId and role from membership", async () => {
    const sb = fakeSupabase({ user: { id: "u1" }, membership: { tenant_id: "t1", role: "owner" } });
    await expect(requireTenantContext(sb as any)).resolves.toEqual({ userId: "u1", tenantId: "t1", role: "owner" });
    expect(sb.calls[0]).toEqual({ table: "memberships", eq: [["user_id", "u1"]] });
  });

  it("ignores any tenant id in cookies or headers", async () => {
    const sb = fakeSupabase({ user: { id: "u1" }, membership: { tenant_id: "t1", role: "member" } });
    const ctx = await requireTenantContext(sb as any);
    expect(ctx.tenantId).toBe("t1");
  });

  it("rejects an unknown role value in the membership row", async () => {
    const sb = fakeSupabase({ user: { id: "u1" }, membership: { tenant_id: "t1", role: "admin" } });
    await expect(requireTenantContext(sb as any)).rejects.toBeInstanceOf(NoTenantError);
  });
});

describe("resolveTenantContext / getMembership", () => {
  it("returns null when there is no session (no redirect)", async () => {
    const sb = fakeSupabase({ user: null, membership: null });
    await expect(resolveTenantContext(sb as any)).resolves.toBeNull();
    expect(redirect).not.toHaveBeenCalled();
  });
  it("getMembership maps row", async () => {
    const sb = fakeSupabase({ user: { id: "u1" }, membership: { tenant_id: "t9", role: "member" } });
    await expect(getMembership(sb as any, "u1")).resolves.toEqual({ tenantId: "t9", role: "member" });
  });
});
