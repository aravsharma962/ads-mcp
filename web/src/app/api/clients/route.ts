import { z } from "zod";
import { apiContext, json, readJson } from "@/lib/api";
import { DEFAULT_TARGETS, METRIC_KEYS } from "@/lib/metrics";

const CreateClient = z.object({
  name: z.string().trim().min(1).max(120),
  currency: z.string().trim().length(3).regex(/^[A-Za-z]{3}$/).transform((s) => s.toUpperCase()),
  timezone: z.string().trim().min(3).max(64),
});

export async function GET() {
  const a = await apiContext();
  if (a instanceof Response) return a;
  const { data } = await a.db
    .from("clients")
    .select("id, name, currency, timezone")
    .eq("tenant_id", a.ctx.tenantId)
    .order("created_at", { ascending: false });
  return json({ clients: data ?? [] });
}

export async function POST(request: Request) {
  const a = await apiContext();
  if (a instanceof Response) return a;
  if (a.ctx.role !== "owner") return json({ error: "Only the agency owner can create clients." }, 403);
  const parsed = CreateClient.safeParse(await readJson(request));
  if (!parsed.success) return json({ error: "Enter a client name, a 3-letter currency code and a timezone." }, 400);
  const { data: client, error } = await a.db
    .from("clients")
    .insert({ tenant_id: a.ctx.tenantId, ...parsed.data, roas_source: "tracking" })
    .select("id, name, currency, timezone")
    .single();
  if (error || !client) return json({ error: "Could not create the client." }, 500);
  const now = new Date().toISOString();
  await a.db.from("targets").insert(
    METRIC_KEYS.map((m) => ({
      client_id: (client as { id: string }).id,
      metric: m,
      min_value: DEFAULT_TARGETS[m].min,
      max_value: DEFAULT_TARGETS[m].max,
      updated_at: now,
    })),
  );
  return json({ client }, 201);
}
