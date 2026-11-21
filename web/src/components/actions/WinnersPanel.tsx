import type { AdAction } from "@/lib/actions/types";
import { formatMoney } from "@/lib/format";
import CopyButton from "./CopyButton";

export function winnersText(winners: AdAction[], currency: string): string {
  return winners.map((w) => `${w.name} (ID ${w.ad_id})${w.recent.cost_per_result !== null ? ` - ${formatMoney(w.recent.cost_per_result, currency)} per result` : ""}`).join("\n");
}

export default function WinnersPanel({ winners, currency }: { winners: AdAction[]; currency: string }) {
  return (
    <section aria-label="Copy winners" className="rounded border p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-medium">Copy winners</h2>
        {winners.length > 0 && <CopyButton text={winnersText(winners, currency)} label="Copy winners list" />}
      </div>
      {winners.length === 0 ? (
        <p className="mt-2 text-sm text-gray-600">No winners yet. An ad needs enough impressions and results before it can be called a winner.</p>
      ) : (
        <>
          <p className="mt-1 text-sm text-gray-600">Duplicate these ads in Meta Ads Manager to test them in new audiences.</p>
          <ol className="mt-2 list-decimal pl-5 text-sm">
            {winners.map((w) => <li key={w.ad_id}>{w.name} <span className="text-gray-500">({formatMoney(w.recent.cost_per_result, currency)} per result)</span></li>)}
          </ol>
        </>
      )}
    </section>
  );
}
