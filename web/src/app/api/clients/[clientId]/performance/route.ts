import { apiContext, getOwnedClient, json, notFound } from "@/lib/api";
import { fetchPerformance, hubFailure } from "@/lib/actions/data";
import { LEVELS, validateRange, type Level } from "@/lib/performance";

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

  try {
    const p = await fetchPerformance(a, client, range, level);
    return json({
      currency: p.currency, tracking: p.tracking, business_type: p.business_type, level,
      attribution: "account default", rows: p.rows, totals: p.totals, unattributed: p.unattributed,
    });
  } catch (e) {
    return hubFailure(e);
  }
}
