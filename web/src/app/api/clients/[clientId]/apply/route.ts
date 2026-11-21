import { apiContext, getOwnedClient, json, notFound, readJson } from "@/lib/api";
import { ApplyBody, applyAction, loadApplyLog } from "@/lib/actions/apply";
import { hubFailure } from "@/lib/actions/data";
import type { ApplyLogResponse } from "@/lib/actions/types";

type Ctx = { params: Promise<{ clientId: string }> };

/** Owner only. Body: { ad_id, action }. The verdict is recomputed here; anything else the browser sends is ignored. */
export async function POST(request: Request, { params }: Ctx) {
  const a = await apiContext();
  if (a instanceof Response) return a;
  const client = await getOwnedClient(a.db, a.ctx.tenantId, (await params).clientId);
  if (!client) return notFound();
  if (a.ctx.role !== "owner") return json({ error: "Only the agency owner can change ads in Meta." }, 403);
  const parsed = ApplyBody.safeParse(await readJson(request));
  if (!parsed.success) return json({ error: "Send { \"ad_id\": \"...\", \"action\": \"pause\" | \"scale\" | \"resume\" }." }, 400);
  try {
    const r = await applyAction(a, client, parsed.data);
    return json(r.body, r.status);
  } catch (e) {
    return hubFailure(e);
  }
}

export async function GET(_req: Request, { params }: Ctx) {
  const a = await apiContext();
  if (a instanceof Response) return a;
  const client = await getOwnedClient(a.db, a.ctx.tenantId, (await params).clientId);
  if (!client) return notFound();
  const body: ApplyLogResponse = await loadApplyLog(a.db, client.id);
  return json(body);
}
