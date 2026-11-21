import type { LeadRow } from "./types";

const cost = (spend: number, n: number): number | null => {
  if (n <= 0 || !Number.isFinite(spend)) return null;
  const v = spend / n;
  return Number.isFinite(v) ? v : null;
};

/**
 * `total` counts all leads. Costs use ad-attributed leads only (ad_id not null), because spend only buys those;
 * `qualified` and `won` count all leads. Costs are null when the count is 0.
 */
export function leadStats(leads: LeadRow[], spend: number): {
  total: number; attributed_total: number; qualified: number; won: number; cost_per_lead: number | null; cost_per_qualified_lead: number | null;
} {
  const attributed = leads.filter((l) => l.ad_id !== null);
  const isQualified = (l: LeadRow) => l.status === "qualified" || l.status === "won";
  const won = leads.filter((l) => l.status === "won").length;
  const qualified = leads.filter(isQualified).length;
  return {
    total: leads.length, attributed_total: attributed.length, qualified, won,
    cost_per_lead: cost(spend, attributed.length), cost_per_qualified_lead: cost(spend, attributed.filter(isQualified).length),
  };
}
