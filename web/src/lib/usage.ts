import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createServiceClient } from "@/lib/supabase/service";

export class CapReachedError extends Error {
  constructor() {
    super("Monthly AI usage limit reached. Contact your agency owner.");
    this.name = "CapReachedError";
  }
}

export function monthlyCap(): number {
  const n = Number(process.env.AI_MONTHLY_TOKEN_CAP);
  return Number.isFinite(n) && n > 0 ? n : 200000;
}

type Opts = { db?: SupabaseClient; now?: Date };
const PAGE = 1000;

export async function monthlyUsage(tenantId: string, opts: Opts = {}): Promise<number> {
  const db = opts.db ?? createServiceClient();
  const now = opts.now ?? new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
  let total = 0;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await db
      .from("usage_events")
      .select("tokens_in, tokens_out")
      .eq("tenant_id", tenantId)
      .gte("created_at", start)
      .range(from, from + PAGE - 1);
    if (error) throw new Error("Could not read AI usage.");
    const rows = (data ?? []) as { tokens_in: number | null; tokens_out: number | null }[];
    for (const r of rows) total += (r.tokens_in ?? 0) + (r.tokens_out ?? 0);
    if (rows.length < PAGE) break;
  }
  return total;
}

export async function assertWithinCap(tenantId: string, opts: Opts = {}): Promise<void> {
  if ((await monthlyUsage(tenantId, opts)) >= monthlyCap()) throw new CapReachedError();
}

export async function recordUsage(
  row: { tenantId: string; userId: string; provider: string; tokensIn: number; tokensOut: number },
  opts: { db?: SupabaseClient } = {},
): Promise<void> {
  const db = opts.db ?? createServiceClient();
  await db.from("usage_events").insert({
    tenant_id: row.tenantId,
    user_id: row.userId,
    provider: row.provider,
    tokens_in: Math.max(0, Math.round(row.tokensIn || 0)),
    tokens_out: Math.max(0, Math.round(row.tokensOut || 0)),
    created_at: new Date().toISOString(),
  });
}
