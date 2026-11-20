import { NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";
import { NoTenantError, resolveTenantContext, type TenantContext } from "@/lib/tenant";

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function json(data: unknown, status = 200, headers?: Record<string, string>) {
  return NextResponse.json(data, { status, headers });
}
export const notFound = () => json({ error: "Not found." }, 404);

export type Api = { ctx: TenantContext; db: SupabaseClient };

/** Resolves the tenant from the verified session only. Returns a Response on failure. */
export async function apiContext(): Promise<Api | Response> {
  const db = (await createClient()) as unknown as SupabaseClient;
  try {
    const ctx = await resolveTenantContext(db);
    if (!ctx) return json({ error: "Sign in required." }, 401);
    return { ctx, db };
  } catch (e) {
    if (e instanceof NoTenantError) return json({ error: e.message }, 403);
    throw e;
  }
}

export type ClientRow = {
  id: string;
  tenant_id: string;
  name: string;
  currency: string;
  timezone: string;
  roas_source: string;
};

/** Tenant-scoped client lookup. A foreign or unknown id is indistinguishable: null. */
export async function getOwnedClient(db: SupabaseClient, tenantId: string, clientId: string): Promise<ClientRow | null> {
  if (!UUID_RE.test(clientId)) return null;
  const { data } = await db.from("clients").select("*").eq("id", clientId).eq("tenant_id", tenantId).maybeSingle();
  return (data as ClientRow | null) ?? null;
}

export async function readJson(request: Request): Promise<unknown | undefined> {
  try {
    return await request.json();
  } catch {
    return undefined;
  }
}
