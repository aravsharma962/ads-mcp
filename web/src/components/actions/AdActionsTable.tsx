import type { AdAction } from "@/lib/actions/types";
import { formatInt, formatMoney } from "@/lib/format";
import VerdictBadge from "./VerdictBadge";

const CONF_LABEL = { low: "Low", medium: "Medium", high: "High" } as const;

export default function AdActionsTable({ actions, currency, resultLabel }: { actions: AdAction[]; currency: string; resultLabel: string }) {
  if (actions.length === 0) {
    return <p className="rounded border p-4 text-sm text-gray-600">No ads found. Connect a Meta ad account on the Accounts tab, or wait until your ads have delivered.</p>;
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-sm">
        <thead>
          <tr className="border-b">
            <th className="p-2">Ad</th><th className="p-2">Verdict</th><th className="p-2">Confidence</th>
            <th className="p-2">Spend</th><th className="p-2">Cost per {resultLabel}</th><th className="p-2">Why</th><th className="p-2">Suggestion</th>
          </tr>
        </thead>
        <tbody>
          {actions.map((a) => (
            <tr key={a.ad_id} className="border-b align-top" data-verdict={a.verdict}>
              <td className="p-2">
                <div className="flex items-center gap-2">
                  {a.thumbnail_url && (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={a.thumbnail_url} alt={a.name} width={40} height={40} loading="lazy" referrerPolicy="no-referrer" className="h-10 w-10 rounded object-cover" />
                  )}
                  <span>{a.name}</span>
                </div>
              </td>
              <td className="p-2"><VerdictBadge verdict={a.verdict} /></td>
              <td className="p-2">{CONF_LABEL[a.confidence]}</td>
              <td className="p-2">{formatMoney(a.recent.spend, currency)}<div className="text-xs text-gray-500">{formatInt(a.recent.impressions)} impressions</div></td>
              <td className="p-2">{formatMoney(a.recent.cost_per_result, currency)}</td>
              <td className="p-2">
                {a.reasons.length === 0 ? <span className="text-gray-500">-</span> : (
                  <ul className="list-disc pl-4">{a.reasons.map((r, i) => <li key={i}>{r}</li>)}</ul>
                )}
              </td>
              <td className="p-2">{a.suggestion}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
