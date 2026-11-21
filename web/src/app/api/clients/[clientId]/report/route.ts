import { apiContext, getOwnedClient, json, notFound } from "@/lib/api";
import { hubFailure, loadActionsData } from "@/lib/actions/data";
import { buildReport } from "@/lib/actions/report";
import type { ReportResponse } from "@/lib/actions/types";

type Ctx = { params: Promise<{ clientId: string }> };

export async function GET(_req: Request, { params }: Ctx) {
  const a = await apiContext();
  if (a instanceof Response) return a;
  const client = await getOwnedClient(a.db, a.ctx.tenantId, (await params).clientId);
  if (!client) return notFound();
  try {
    const d = await loadActionsData(a, client);
    const report = buildReport({
      clientName: client.name, type: client.business_type, currency: d.currency, windows: d.windows,
      recentTotals: d.recent.totals, previousTotals: d.previous.totals, actions: d.actions, targets: d.targets, adAccount: d.adAccount,
    });
    const body: ReportResponse = { ...report, ad_account: d.adAccount };
    return json(body);
  } catch (e) {
    return hubFailure(e);
  }
}
