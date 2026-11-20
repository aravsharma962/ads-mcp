import { defaultTargetsFor, metricsForType, type Band, type BusinessType, type MetricKey, type Targets } from "@/lib/metrics";

/** Targets of the client's business type only. Missing rows fall back to the type's defaults (new metrics: empty). */
export async function loadTargets(db: any, clientId: string, type: BusinessType = "ecommerce"): Promise<Targets> {
  const { data } = await db.from("targets").select("metric, min_value, max_value").eq("client_id", clientId);
  const out: Targets = {};
  const defaults = defaultTargetsFor(type) as Record<MetricKey, Band>;
  const keys = metricsForType(type);
  for (const k of keys) out[k] = { ...defaults[k] };
  for (const r of (data ?? []) as { metric: MetricKey; min_value: number | null; max_value: number | null }[]) {
    if (keys.includes(r.metric)) out[r.metric] = { min: r.min_value ?? null, max: r.max_value ?? null };
  }
  return out;
}

/** Creates target rows for the type's metrics that do not exist yet. Never overwrites an existing row. */
export async function ensureTargetRows(db: any, clientId: string, type: BusinessType): Promise<boolean> {
  const { data } = await db.from("targets").select("metric").eq("client_id", clientId);
  const have = new Set(((data ?? []) as { metric: string }[]).map((r) => r.metric));
  const defaults = defaultTargetsFor(type) as Record<MetricKey, Band>;
  const now = new Date().toISOString();
  const rows = metricsForType(type)
    .filter((m) => !have.has(m))
    .map((m) => ({ client_id: clientId, metric: m, min_value: defaults[m].min, max_value: defaults[m].max, updated_at: now }));
  if (rows.length === 0) return true;
  const { error } = await db.from("targets").insert(rows);
  return !error;
}
