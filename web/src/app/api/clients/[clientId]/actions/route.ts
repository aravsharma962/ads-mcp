import { apiContext, getOwnedClient, json, notFound } from "@/lib/api";
import { hubFailure, loadActionsData } from "@/lib/actions/data";
import { resultLabel, pickWinners } from "@/lib/actions/verdicts";
import { VERDICTS, type ActionsResponse, type Verdict } from "@/lib/actions/types";

type Ctx = { params: Promise<{ clientId: string }> };

export async function GET(_req: Request, { params }: Ctx) {
  const a = await apiContext();
  if (a instanceof Response) return a;
  const client = await getOwnedClient(a.db, a.ctx.tenantId, (await params).clientId);
  if (!client) return notFound();
  try {
    const d = await loadActionsData(a, client);
    const counts = Object.fromEntries(VERDICTS.map((v) => [v, 0])) as Record<Verdict, number>;
    for (const x of d.actions) counts[x.verdict]++;
    const body: ActionsResponse = {
      currency: d.currency, business_type: client.business_type, result_label: resultLabel(client.business_type),
      rules: d.rules, windows: d.windows, actions: d.actions, winners: pickWinners(d.actions), counts, ad_account: d.adAccount,
    };
    return json(body);
  } catch (e) {
    return hubFailure(e);
  }
}
