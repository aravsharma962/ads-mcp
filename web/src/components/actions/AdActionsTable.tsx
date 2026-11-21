import type { AdAction, ActionLogRow, ApplyAction } from "@/lib/actions/types";
import { formatInt, formatMoney } from "@/lib/format";
import VerdictBadge from "./VerdictBadge";
import { APPLY_LABEL } from "./ApplyConfirm";

export type ApplyControls = {
  isOwner: boolean;
  writesEnabled: boolean;
  log: ActionLogRow[];
  onApply: (ad: AdAction, action: ApplyAction) => void;
};

const COOLDOWN_MS = 3 * 24 * 60 * 60 * 1000;

/** Which apply button (if any) an ad gets, and why it may be disabled. */
export function applyOptionFor(ad: AdAction, c: ApplyControls, now = Date.now()): { action: ApplyAction; disabledReason: string | null } | null {
  const mine = c.log.filter((r) => r.ad_id === ad.ad_id && (r.status === "ok" || r.status === "unknown")).sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
  let action: ApplyAction | null = null;
  if (mine[0]?.action === "pause") action = "resume";
  else if (ad.verdict === "pause") action = "pause";
  else if (ad.verdict === "scale") action = "scale";
  if (!action) return null;
  let disabledReason: string | null = null;
  if (!c.isOwner) disabledReason = "Only the agency owner can change ads in Meta.";
  else if (!c.writesEnabled) disabledReason = "Changes in Meta are not enabled.";
  else if (action === "scale" && mine.some((r) => r.action === "scale" && now - Date.parse(r.created_at) < COOLDOWN_MS)) {
    disabledReason = "Budget was already raised in the last 3 days. Try again later.";
  }
  return { action, disabledReason };
}

const CONF_LABEL = { low: "Low", medium: "Medium", high: "High" } as const;

export default function AdActionsTable({ actions, currency, resultLabel, apply }: { actions: AdAction[]; currency: string; resultLabel: string; apply?: ApplyControls }) {
  if (actions.length === 0) {
    return <p className="rounded border p-4 text-sm text-gray-600">No ads found. Connect a Meta ad account on the Accounts tab, or wait until your ads have delivered.</p>;
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-sm">
        <thead>
          <tr className="border-b">
            <th className="p-2">Ad</th><th className="p-2">Verdict</th><th className="p-2">Confidence</th>
            <th className="p-2">Spend</th><th className="p-2">Cost per {resultLabel}</th><th className="p-2">Why</th><th className="p-2">Suggestion</th>{apply && <th className="p-2">Apply</th>}
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
              {apply && (() => {
                const opt = applyOptionFor(a, apply);
                if (!opt) return <td className="p-2" />;
                return (
                  <td className="p-2">
                    <button type="button" disabled={!!opt.disabledReason} onClick={() => apply.onApply(a, opt.action)}
                      aria-label={APPLY_LABEL[opt.action]} className="rounded border px-2 py-1 text-xs disabled:opacity-50">{APPLY_LABEL[opt.action]}</button>
                    {opt.disabledReason && <div className="mt-1 max-w-[12rem] text-xs text-gray-500">{opt.disabledReason}</div>}
                  </td>
                );
              })()}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
