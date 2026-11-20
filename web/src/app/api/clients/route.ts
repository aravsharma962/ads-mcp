import { z } from "zod";
import { apiContext, json, readJson } from "@/lib/api";
import { BUSINESS_TYPES } from "@/lib/metrics";
import { ensureTargetRows } from "@/lib/targets";

const CreateClient = z.object({
  name: z.string().trim().min(1).max(120),
  currency: z.string().trim().length(3).regex(/^[A-Za-z]{3}$/).transform((s) => s.toUpperCase()),
  timezone: z.string().trim().min(3).max(64),
  business_type: z.enum(BUSINESS_TYPES),
});

export async function GET() {
  const a = await apiContext();
  if (a instanceof Response) return a;
  const { data } = await a.db
    .from("clients")
    .select("id, name, currency, timezone, business_type")
    .eq("tenant_id", a.ctx.tenantId)
    .order("created_at", { ascending: false });
  return json({ clients: data ?? [] });
}

export async function POST(request: Request) {
  const a = await apiContext();
  if (a instanceof Response) return a;
  if (a.ctx.role !== "owner") return json({ error: "Only the agency owner can create clients." }, 403);
  const parsed = CreateClient.safeParse(await readJson(request));
  if (!parsed.success) return json({ error: "Enter a client name, a business type, a 3-letter currency code and a timezone." }, 400);
  const { data: client, error } = await a.db
    .from("clients")
    .insert({ tenant_id: a.ctx.tenantId, ...parsed.data, roas_source: "tracking" })
    .select("id, name, currency, timezone, business_type")
    .single();
  if (error || !client) return json({ error: "Could not create the client." }, 500);
  await ensureTargetRows(a.db, (client as { id: string }).id, parsed.data.business_type);
  return json({ client }, 201);
}
