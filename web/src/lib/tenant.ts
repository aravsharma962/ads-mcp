import { redirect } from "next/navigation";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";

export type Role = "owner" | "member";
export type TenantContext = { userId: string; tenantId: string; role: Role };

export class NoTenantError extends Error {
  constructor() {
    super("Your account is not linked to an agency. Contact your agency owner.");
    this.name = "NoTenantError";
  }
}

/** Reads the caller's membership. The tenant comes only from this row. */
export async function getMembership(
  supabase: Pick<SupabaseClient, "from">,
  userId: string,
): Promise<{ tenantId: string; role: Role } | null> {
  const { data } = await supabase
    .from("memberships")
    .select("tenant_id, role")
    .eq("user_id", userId)
    .maybeSingle();
  if (!data) return null;
  const row = data as { tenant_id: string; role: string };
  if (row.role !== "owner" && row.role !== "member") return null;
  return { tenantId: row.tenant_id, role: row.role };
}

/** Returns null when there is no verified session; throws NoTenantError without membership. */
export async function resolveTenantContext(
  supabase: Pick<SupabaseClient, "from" | "auth">,
): Promise<TenantContext | null> {
  const { data } = await supabase.auth.getUser();
  const user = data?.user;
  if (!user) return null;
  const m = await getMembership(supabase, user.id);
  if (!m) throw new NoTenantError();
  return { userId: user.id, tenantId: m.tenantId, role: m.role };
}

/** For pages and layouts: redirects to /login when signed out. */
export async function requireTenantContext(
  supabase?: Pick<SupabaseClient, "from" | "auth">,
): Promise<TenantContext> {
  const sb = supabase ?? (await createClient());
  const ctx = await resolveTenantContext(sb);
  if (!ctx) redirect("/login");
  return ctx;
}
