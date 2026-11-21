import { EMPTY_BAND, metricLabel, metricsForType, statusFor, type BusinessType, type Targets } from "@/lib/metrics";
import { formatInt, formatMoney } from "@/lib/format";
import type { PerfTotals } from "@/lib/performance";
import type { AdAction, PeriodStats, ReportResponse } from "./types";

const fin = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const safe = (v: unknown): number => (fin(v) ? v : 0);
const ratio = (n: number, d: number, mult = 1): number | null => (d > 0 && Number.isFinite(n) ? (n / d) * mult : null);

/** Local copy of the result definition (T3 owns the canonical resultCount): leads, signups or purchases. */
function resultsOf(t: PerfTotals, type: BusinessType): number {
  return safe(type === "lead_gen" ? t.leads : type === "saas_b2b" ? t.signups : t.purchases);
}
const RESULT_WORD: Record<BusinessType, string> = { lead_gen: "lead", saas_b2b: "signup", ecommerce: "purchase" };

function periodStats(t: PerfTotals, type: BusinessType): PeriodStats {
  const spend = safe(t.spend), impressions = safe(t.impressions), link_clicks = safe(t.link_clicks);
  const results = resultsOf(t, type);
  const f = (t as { frequency?: unknown }).frequency;
  return {
    spend, impressions, link_clicks, results,
    frequency: fin(f) && f > 0 ? f : null,
    ctr: ratio(link_clicks, impressions, 100),
    cost_per_result: ratio(spend, results),
  };
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

function nextActions(actions: AdAction[]): string[] {
  const n = (v: AdAction["verdict"]) => actions.filter((a) => a.verdict === v).length;
  const out: string[] = [];
  if (n("pause")) out.push(`Pause ${plural(n("pause"), "ad", "ads")}`);
  if (n("refresh_creative")) out.push(`Refresh creative on ${plural(n("refresh_creative"), "ad", "ads")}`);
  if (n("scale")) out.push(`Raise budget on ${plural(n("scale"), "winner", "winners")}`);
  if (n("too_early")) out.push(`Wait for more data on ${plural(n("too_early"), "ad", "ads")}`);
  return out.length ? out : ["No changes needed. Keep watching results."];
}

function change(cur: number | null, prev: number | null): string {
  if (cur === null) return "no data";
  if (prev === null || prev === 0) return "no previous data";
  const p = Math.round(((cur - prev) / prev) * 100);
  return `${p > 0 ? "+" : ""}${p}% vs previous`;
}

export function buildReport(input: {
  clientName: string; type: BusinessType; currency: string; windows: ReportResponse["windows"];
  recentTotals: PerfTotals; previousTotals: PerfTotals; actions: AdAction[]; targets: Targets;
  adAccount?: boolean; // false when no ad account is connected (default true)
}): ReportResponse {
  const { clientName, type, currency, windows, actions, targets } = input;
  const adAccount = input.adAccount !== false;
  const recent = periodStats(input.recentTotals, type);
  const previous = periodStats(input.previousTotals, type);

  const target_checks = metricsForType(type).map((metric) => {
    const raw = input.recentTotals.rates?.[metric];
    const value = fin(raw) ? raw : null;
    return { metric, label: metricLabel(type, metric), value, status: statusFor(metric, value, targets[metric] ?? EMPTY_BAND) };
  });

  const withResults = actions.filter((a) => a.recent.results > 0 && a.recent.cost_per_result !== null);
  const top_ads = [...withResults].sort((a, b) => a.recent.cost_per_result! - b.recent.cost_per_result!).slice(0, 3);
  const topIds = new Set(top_ads.map((a) => a.ad_id));
  const bottom_ads = actions
    .filter((a) => a.recent.spend > 0 && !topIds.has(a.ad_id))
    .sort((a, b) => {
      const ar = a.recent.cost_per_result, br = b.recent.cost_per_result;
      if (ar === null && br === null) return b.recent.spend - a.recent.spend;
      if (ar === null) return -1;
      if (br === null) return 1;
      return br - ar;
    })
    .slice(0, 3);

  const next_actions = nextActions(actions);

  const word = RESULT_WORD[type];
  const lines = [
    `Ads report for ${clientName}`,
    `Period: ${windows.recent.from} to ${windows.recent.to} (compared with ${windows.previous.from} to ${windows.previous.to})`,
    "",
    ...(adAccount ? [
      `Spend: ${formatMoney(recent.spend, currency)} (${change(recent.spend, previous.spend)})`,
      `Results (${word}s): ${formatInt(recent.results)} (${change(recent.results, previous.results)})`,
      `Cost per ${word}: ${formatMoney(recent.cost_per_result, currency)} (${change(recent.cost_per_result, previous.cost_per_result)})`,
    ] : ["No ad data yet. Connect an ad account to see spend and results."]),
    "",
    "What we will do next:",
    ...next_actions.map((a) => `- ${a}`),
  ];

  return {
    currency, business_type: type, client_name: clientName, windows, recent, previous,
    target_checks, top_ads, bottom_ads, next_actions, whatsapp_text: lines.join("\n"),
  };
}
