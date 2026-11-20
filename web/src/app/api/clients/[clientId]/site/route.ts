import { apiContext, getOwnedClient, json, notFound, readJson } from "@/lib/api";
import { createServiceClient } from "@/lib/supabase/service";
import { newSiteKey, normalizeOrigins, trackingHealth } from "@/lib/tracking";

type Ctx = { params: Promise<{ clientId: string }> };
const COLS = "site_key, allowed_origins, conversion_events";
const BAD_ORIGINS = "Enter the website addresses as valid http or https URLs (at most 20).";

export async function GET(_req: Request, { params }: Ctx) {
  const a = await apiContext();
  if (a instanceof Response) return a;
  const client = await getOwnedClient(a.db, a.ctx.tenantId, (await params).clientId);
  if (!client) return notFound();
  const { data: site } = await a.db.from("sites").select(COLS).eq("client_id", client.id).maybeSingle();
  return json({ site: site ?? null, health: site ? await trackingHealth(a.db, client.id) : null });
}

export async function POST(request: Request, { params }: Ctx) {
  const a = await apiContext();
  if (a instanceof Response) return a;
  const client = await getOwnedClient(a.db, a.ctx.tenantId, (await params).clientId);
  if (!client) return notFound();
  if (a.ctx.role !== "owner") return json({ error: "Only the agency owner can set up tracking." }, 403);
  const body = (await readJson(request)) as { allowed_origins?: unknown } | undefined;
  const origins = normalizeOrigins(body?.allowed_origins);
  if (!origins) return json({ error: BAD_ORIGINS }, 400);
  const { data: existing } = await a.db.from("sites").select("site_key").eq("client_id", client.id).maybeSingle();
  if (existing) return json({ error: "Tracking is already set up for this client." }, 409);
  // Direct INSERT is revoked for browser sessions (migration 003); the owner and client checks above gate this write.
  const { data, error } = await createServiceClient().from("sites")
    .insert({ client_id: client.id, site_key: newSiteKey(), allowed_origins: origins })
    .select(COLS).single();
  if (error || !data) return json({ error: "Could not create the tracking site." }, 500);
  return json({ site: data }, 201);
}

export async function PUT(request: Request, { params }: Ctx) {
  const a = await apiContext();
  if (a instanceof Response) return a;
  const client = await getOwnedClient(a.db, a.ctx.tenantId, (await params).clientId);
  if (!client) return notFound();
  if (a.ctx.role !== "owner") return json({ error: "Only the agency owner can change tracking settings." }, 403);
  const body = ((await readJson(request)) ?? {}) as { allowed_origins?: unknown; rotate_key?: unknown };
  const patch: Record<string, unknown> = {};
  if (body.allowed_origins !== undefined) {
    const origins = normalizeOrigins(body.allowed_origins);
    if (!origins) return json({ error: BAD_ORIGINS }, 400);
    patch.allowed_origins = origins;
  }
  if (body.rotate_key === true) patch.site_key = newSiteKey();
  if (Object.keys(patch).length === 0) return json({ error: "Nothing to update." }, 400);
  const { data: existing } = await a.db.from("sites").select("site_key").eq("client_id", client.id).maybeSingle();
  if (!existing) return notFound();
  const { data, error } = await a.db.from("sites").update(patch).eq("client_id", client.id).select(COLS).single();
  if (error || !data) return json({ error: "Could not update the tracking site." }, 500);
  return json({ site: data });
}
