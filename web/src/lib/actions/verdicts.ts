import { metricLabel, statusFor, type BusinessType, type Targets } from "@/lib/metrics";
import type { PerfRow } from "@/lib/performance";
import type { ActionRules, AdAction, Confidence, PeriodStats, Verdict } from "./types";

const LABELS: Record<BusinessType, string> = { ecommerce: "purchase", lead_gen: "lead", saas_b2b: "signup" };
export const resultLabel = (type: BusinessType): string => LABELS[type];

export function resultCount(row: PerfRow, type: BusinessType): number {
  const n = type === "ecommerce" ? row.purchases : type === "lead_gen" ? row.leads : row.signups;
  return Number.isFinite(n) && n > 0 ? n : 0;
}

const SEVERITY: Record<Verdict, number> = { pause: 0, refresh_creative: 1, keep_watch: 2, too_early: 3, scale: 4 };
const SCALE_SUGGESTION = "Raise the budget by at most 20%, then wait 3 days before the next change.";

const fmt = (n: number, d = 1) => n.toFixed(d);
const money = (n: number, cur: string) => `${cur} ${n >= 100 ? Math.round(n).toLocaleString("en-US") : n.toFixed(2)}`;
const pct = (n: number) => `${Math.round(n)}%`;
const costOf = (spend: number, results: number): number | null => (results > 0 && spend >= 0 ? spend / results : null);

function stats(row: PerfRow | undefined, type: BusinessType): PeriodStats {
  if (!row) return { spend: 0, impressions: 0, link_clicks: 0, results: 0, frequency: null, ctr: null, cost_per_result: null };
  const results = resultCount(row, type);
  return {
    spend: row.spend,
    impressions: row.impressions,
    link_clicks: row.link_clicks,
    results,
    frequency: row.frequency !== null && row.frequency > 0 ? row.frequency : null,
    ctr: row.impressions > 0 ? (row.link_clicks / row.impressions) * 100 : null,
    cost_per_result: costOf(row.spend, results),
  };
}

const keyOf = (r: PerfRow) => r.ad_id ?? r.id;

function confidenceOf(s: PeriodStats): Confidence {
  if (s.impressions >= 10000 && s.results >= 10) return "high";
  if (s.impressions >= 3000 && s.results >= 3) return "medium";
  return "low";
}

type TargetCheck = { met: boolean; text: string } | { noData: true } | null;
/** A ROAS target exists but the ad has no ROAS data: never scale, never fall back to the account average. */
const NO_ROAS_DATA: { noData: true } = { noData: true };

/** Looks at the type's own target. Returns null when the client has none set that applies. */
function checkTarget(row: PerfRow, recent: PeriodStats, type: BusinessType, targets: Targets, currency: string): TargetCheck {
  const label = metricLabel(type, type === "ecommerce" ? "roas" : "cpl");
  if (type === "ecommerce") {
    const band = targets.roas;
    if (band && (band.min !== null || band.max !== null)) {
      const roas = row.rates.roas;
      if (typeof roas !== "number" || !Number.isFinite(roas) || roas <= 0) return NO_ROAS_DATA;
      const ok = statusFor("roas", roas, band) !== "off_target";
      return { met: ok, text: `ROAS ${fmt(roas)}x ${ok ? "meets" : "is below"} your target${band.min !== null ? ` (min ${band.min}x)` : ""}` };
    }
    return null;
  }
  const cpr = recent.cost_per_result;
  const cpl = targets.cpl;
  if (cpl && cpl.max !== null) {
    if (cpr === null) return null;
    const ok = cpr <= cpl.max;
    return { met: ok, text: `${label.replace(/ \(CPL\)$/, "")} ${money(cpr, currency)} ${ok ? "is within" : "is above"} your target (max ${money(cpl.max, currency)})` };
  }
  const ct = targets.cost_per_trial;
  if (type === "saas_b2b" && ct && ct.max !== null) {
    const v = row.rates.cost_per_trial;
    if (typeof v !== "number") return null;
    const ok = v <= ct.max;
    return { met: ok, text: `Cost per trial ${money(v, currency)} ${ok ? "is within" : "is above"} your target (max ${money(ct.max, currency)})` };
  }
  return null;
}

export function computeActions(input: {
  type: BusinessType; recent: PerfRow[]; previous: PerfRow[]; rules: ActionRules; targets: Targets; currency: string;
}): AdAction[] {
  const { type, rules, targets, currency } = input;
  const noun = resultLabel(type);
  const prevByKey = new Map<string, PerfRow>();
  for (const p of input.previous) prevByKey.set(keyOf(p), p);

  let totSpend = 0, totResults = 0;
  for (const r of input.recent) { totSpend += r.spend; totResults += resultCount(r, type); }
  const accountAvg = costOf(totSpend, totResults);

  const out: AdAction[] = input.recent.map((row) => {
    const recent = stats(row, type);
    const prevRow = prevByKey.get(keyOf(row));
    const previous = stats(prevRow, type);
    const signals = { frequency: false, ctr_drop: false, cost_rise: false };
    const reasons: string[] = [];
    let verdict: Verdict;
    let suggestion: string;

    if (recent.impressions < rules.min_impressions) {
      verdict = "too_early";
      reasons.push(`Only ${Math.round(recent.impressions).toLocaleString("en-US")} impressions so far (need ${rules.min_impressions.toLocaleString("en-US")} to judge this ad)`);
      suggestion = "Give it more time and budget before changing anything.";
    } else {
      if (recent.frequency !== null && recent.frequency >= rules.frequency_max) {
        signals.frequency = true;
        reasons.push(`Frequency ${fmt(recent.frequency)} (limit ${rules.frequency_max})`);
      }
      if (previous.impressions >= rules.min_impressions && previous.ctr !== null && previous.ctr > 0 && recent.ctr !== null) {
        const drop = ((previous.ctr - recent.ctr) / previous.ctr) * 100;
        if (drop > rules.ctr_drop_pct) {
          signals.ctr_drop = true;
          reasons.push(`CTR fell ${pct(drop)} (${fmt(recent.ctr)}% vs ${fmt(previous.ctr)}%)`);
        }
      }
      if (previous.results > 0 && previous.cost_per_result !== null && previous.cost_per_result > 0) {
        if (recent.results === 0) {
          if (recent.spend >= previous.cost_per_result) {
          signals.cost_rise = true;
          reasons.push(`No ${noun}s this period after ${previous.results} in the previous period (spent ${money(recent.spend, currency)})`);
          }
        } else if (recent.cost_per_result !== null) {
          const rise = ((recent.cost_per_result - previous.cost_per_result) / previous.cost_per_result) * 100;
          if (rise > rules.cost_rise_pct) {
            signals.cost_rise = true;
            reasons.push(`Cost per ${noun} rose ${pct(rise)} (${money(recent.cost_per_result, currency)} vs ${money(previous.cost_per_result, currency)})`);
          }
        }
      }
      const count = Number(signals.frequency) + Number(signals.ctr_drop) + Number(signals.cost_rise);
      if (count >= 3) {
        verdict = "pause";
        suggestion = "Pause this ad and move its budget to a better performing ad.";
      } else if (count === 2) {
        verdict = "refresh_creative";
        suggestion = "Replace the creative (new hook, image or video) and keep the audience.";
      } else if (count === 1) {
        verdict = "keep_watch";
        suggestion = "Do not change anything yet. Check again in 2 to 3 days.";
      } else {
        verdict = "keep_watch";
        suggestion = "No problems found. Keep it running and review again in a few days.";
        let scaleReason: string | null = null;
        if (recent.results >= rules.min_results_scale) {
          const t = checkTarget(row, recent, type, targets, currency);
          if (t && "noData" in t) {
            // keep_watch: target cannot be checked
          } else if (t) {
            if (t.met) scaleReason = t.text;
            else reasons.push(t.text);
          } else if (recent.cost_per_result !== null && accountAvg !== null && accountAvg > 0) {
            const better = ((accountAvg - recent.cost_per_result) / accountAvg) * 100;
            if (better >= rules.scale_better_pct) {
              scaleReason = `Cost per ${noun} ${money(recent.cost_per_result, currency)} is ${pct(better)} cheaper than the account average (${money(accountAvg, currency)})`;
            }
          }
        }
        if (scaleReason) {
          verdict = "scale";
          reasons.push(scaleReason);
          suggestion = SCALE_SUGGESTION;
        } else if (reasons.length === 0) {
          reasons.push(recent.results >= rules.min_results_scale ? "No warning signs, but no clear proof to scale yet" : `No warning signs, but only ${recent.results} ${noun}${recent.results === 1 ? "" : "s"} so far (need ${rules.min_results_scale} to scale)`);
        }
      }
    }

    return {
      ad_id: keyOf(row), name: row.name, thumbnail_url: row.thumbnail_url, campaign_id: row.campaign_id, adset_id: row.adset_id,
      verdict, confidence: confidenceOf(recent), reasons, signals, recent, previous, suggestion,
    };
  });

  return out.sort((a, b) => SEVERITY[a.verdict] - SEVERITY[b.verdict] || b.recent.spend - a.recent.spend);
}

/** "Copy winners" candidates: scale verdicts, cheapest result first (ads with no cost last). */
export function pickWinners(actions: AdAction[], limit = 5): AdAction[] {
  if (!(limit > 0)) return [];
  return actions
    .filter((a) => a.verdict === "scale")
    .sort((a, b) => (a.recent.cost_per_result ?? Infinity) - (b.recent.cost_per_result ?? Infinity))
    .slice(0, limit);
}
