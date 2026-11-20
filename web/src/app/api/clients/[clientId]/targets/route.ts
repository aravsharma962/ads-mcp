import { z } from "zod";
import { apiContext, getOwnedClient, json, notFound, readJson } from "@/lib/api";
import { ALL_METRIC_KEYS, defaultTargetsFor, metricsForType, type Band, type MetricKey } from "@/lib/metrics";
import { loadTargets } from "@/lib/targets";

type Ctx = { params: Promise<{ clientId: string }> };

const num = z.number().finite().nullable();
const Body = z.union([
  z.object({ reset: z.literal(true) }),
  z.object({
    targets: z
      .partialRecord(z.enum(ALL_METRIC_KEYS as [MetricKey, ...MetricKey[]]), z.object({ min: num, max: num }).strict())
  }),
]);

export async function GET(_req: Request, { params }: Ctx) {
  const a = await apiContext();
  if (a instanceof Response) return a;
  const client = await getOwnedClient(a.db, a.ctx.tenantId, (await params).clientId);
  if (!client) return notFound();
  return json({ targets: await loadTargets(a.db, client.id, client.business_type) });
}

export async function PUT(request: Request, { params }: Ctx) {
  const a = await apiContext();
  if (a instanceof Response) return a;
  const client = await getOwnedClient(a.db, a.ctx.tenantId, (await params).clientId);
  if (!client) return notFound();
  const parsed = Body.safeParse(await readJson(request));
  if (!parsed.success || ("targets" in parsed.data && Object.keys(parsed.data.targets).length === 0)) return json({ error: "Invalid targets." }, 400);
  let next: Partial<Record<MetricKey, Band>>;
  if ("reset" in parsed.data) {
    next = defaultTargetsFor(client.business_type) as Partial<Record<MetricKey, Band>>;
  } else {
    next = parsed.data.targets as Partial<Record<MetricKey, Band>>;
    const allowed = metricsForType(client.business_type);
    if (Object.keys(next).some((k) => !allowed.includes(k as MetricKey))) return json({ error: "Invalid targets." }, 400);
    for (const b of Object.values(next)) {
      if (b && b.min !== null && b.max !== null && b.min > b.max) {
        return json({ error: "Minimum cannot be greater than maximum." }, 400);
      }
    }
  }
  const now = new Date().toISOString();
  const rows = (Object.entries(next) as [MetricKey, Band][]).map(([metric, b]) => ({
    client_id: client.id,
    metric,
    min_value: b.min,
    max_value: b.max,
    updated_at: now,
  }));
  const { error } = await a.db.from("targets").upsert(rows, { onConflict: "client_id,metric" });
  if (error) return json({ error: "Could not save targets." }, 500);
  return json({ targets: await loadTargets(a.db, client.id, client.business_type) });
}
