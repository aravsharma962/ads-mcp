import { z } from "zod";
import { apiContext, getOwnedClient, json, notFound, readJson } from "@/lib/api";
import { BUSINESS_TYPES } from "@/lib/metrics";
import { ensureTargetRows } from "@/lib/targets";
import { CONVERSION_EVENTS } from "@/lib/tracking";

type Ctx = { params: Promise<{ clientId: string }> };

const Body = z.object({ business_type: z.enum(BUSINESS_TYPES) }).strict();

/** Owner changes the client's business type. Only that field can be changed here. */
export async function PATCH(request: Request, { params }: Ctx) {
  const a = await apiContext();
  if (a instanceof Response) return a;
  const client = await getOwnedClient(a.db, a.ctx.tenantId, (await params).clientId);
  if (!client) return notFound();
  if (a.ctx.role !== "owner") return json({ error: "Only the agency owner can change the business type." }, 403);
  const parsed = Body.safeParse(await readJson(request));
  if (!parsed.success) return json({ error: "Choose a valid business type." }, 400);
  const type = parsed.data.business_type;
  const { data, error } = await a.db
    .from("clients").update({ business_type: type })
    .eq("id", client.id).eq("tenant_id", a.ctx.tenantId)
    .select("id, name, currency, timezone, business_type").single();
  if (error || !data) return json({ error: "Could not change the business type." }, 500);
  // Rows for the new type's metrics are created on demand (empty targets); existing rows are never overwritten.
  await ensureTargetRows(a.db, client.id, type);
  await a.db.from("sites").update({ conversion_events: CONVERSION_EVENTS[type] }).eq("client_id", client.id);
  return json({ client: data });
}
