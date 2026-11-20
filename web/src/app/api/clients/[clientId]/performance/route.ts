import { apiContext, getOwnedClient, json, notFound } from "@/lib/api";
import { HubError, callTool } from "@/lib/hub";
import { LEVELS, normalizeRow, normalizeUnattributed, sumRows, validateRange, type Level } from "@/lib/performance";

type Ctx = { params: Promise<{ clientId: string }> };

export async function GET(request: Request, { params }: Ctx) {
  const a = await apiContext();
  if (a instanceof Response) return a;
  const client = await getOwnedClient(a.db, a.ctx.tenantId, (await params).clientId);
  if (!client) return notFound();

  const sp = new URL(request.url).searchParams;
  const range = validateRange(sp.get("from"), sp.get("to"));
  const level = sp.get("level") as Level | null;
  if (!range) return json({ error: "Enter a valid date range of at most 366 days." }, 400);
  if (!level || !LEVELS.includes(level)) return json({ error: "Level must be campaign, adset or ad." }, 400);

  const { data: accRows } = await a.db.from("client_accounts").select("external_id").eq("client_id", client.id);
  const accounts = ((accRows ?? []) as { external_id: string }[]).map((r) => r.external_id);
  const { data: site } = await a.db.from("sites").select("id").eq("client_id", client.id).maybeSingle();
  const tracking = !!site;
  const src = { tracking, roasSource: client.roas_source };

  let currency = client.currency;
  let rawRows: unknown[] = [];
  let unattributed = null;
  try {
    if (accounts.length > 0) {
      if (tracking) {
        const res = await callTool(a.ctx.tenantId, "ads_performance", {
          client_id: client.id, date_from: range.from, date_to: range.to, level,
        });
        rawRows = Array.isArray(res?.rows) ? res.rows : [];
        unattributed = normalizeUnattributed(res?.unattributed);
        if (typeof res?.currency === "string") currency = res.currency;
      } else {
        for (const externalId of accounts) {
          const res = await callTool(a.ctx.tenantId, "meta_ads_insights", {
            external_id: externalId, date_from: range.from, date_to: range.to, level,
          });
          if (Array.isArray(res?.rows)) rawRows.push(...res.rows);
          if (typeof res?.currency === "string") currency = res.currency;
        }
      }
    }
  } catch (e) {
    const status = e instanceof HubError && e.status === 429 ? 429 : 502;
    return json({ error: "Could not load performance data right now. Try again in a moment." }, status);
  }

  const rows = rawRows.map((r) => normalizeRow(r, src));
  return json({ currency, tracking, level, attribution: "account default", rows, totals: sumRows(rows, src), unattributed });
}
