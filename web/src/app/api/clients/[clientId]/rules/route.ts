import { z } from "zod";
import { apiContext, getOwnedClient, json, notFound, readJson } from "@/lib/api";
import { parseActionRules } from "@/lib/actions/rules";

type Ctx = { params: Promise<{ clientId: string }> };

const num = z.number().finite();
const Body = z
  .object({
    frequency_max: num, ctr_drop_pct: num, cost_rise_pct: num, min_impressions: num,
    min_results_scale: num, scale_better_pct: num, window_days: num, bounce_seconds: num,
  })
  .partial()
  .strict();

export async function GET(_req: Request, { params }: Ctx) {
  const a = await apiContext();
  if (a instanceof Response) return a;
  const client = await getOwnedClient(a.db, a.ctx.tenantId, (await params).clientId);
  if (!client) return notFound();
  return json({ rules: parseActionRules(client.action_rules) });
}

/** Owner only (same as the clients table policy). Send any subset of the rules; values are clamped to safe ranges. */
export async function PUT(request: Request, { params }: Ctx) {
  const a = await apiContext();
  if (a instanceof Response) return a;
  const client = await getOwnedClient(a.db, a.ctx.tenantId, (await params).clientId);
  if (!client) return notFound();
  if (a.ctx.role !== "owner") return json({ error: "Only the agency owner can change the rules." }, 403);
  const parsed = Body.safeParse(await readJson(request));
  if (!parsed.success || Object.keys(parsed.data).length === 0) return json({ error: "Send the rule values as numbers, for example {\"frequency_max\": 3}." }, 400);
  const next = parseActionRules({ ...parseActionRules(client.action_rules), ...parsed.data });
  const { data, error } = await a.db
    .from("clients").update({ action_rules: next })
    .eq("id", client.id).eq("tenant_id", a.ctx.tenantId).select("id").single();
  if (error || !data) return json({ error: "Could not save the rules." }, 500);
  return json({ rules: next });
}
