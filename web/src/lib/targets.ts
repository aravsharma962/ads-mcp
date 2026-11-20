import { DEFAULT_TARGETS, METRIC_KEYS, type Band, type MetricKey } from "@/lib/metrics";

export async function loadTargets(db: any, clientId: string): Promise<Record<MetricKey, Band>> {
  const { data } = await db.from("targets").select("metric, min_value, max_value").eq("client_id", clientId);
  const out = {} as Record<MetricKey, Band>;
  for (const k of METRIC_KEYS) out[k] = { ...DEFAULT_TARGETS[k] };
  for (const r of (data ?? []) as { metric: MetricKey; min_value: number | null; max_value: number | null }[]) {
    if (r.metric in out) out[r.metric] = { min: r.min_value ?? null, max: r.max_value ?? null };
  }
  return out;
}
