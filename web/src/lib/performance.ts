import { computeRates, TRACKING_ONLY_METRICS, type BusinessType, type Rates, type Totals } from "@/lib/metrics";

export const LEVELS = ["campaign", "adset", "ad"] as const;
export type Level = (typeof LEVELS)[number];

export type PerfRow = {
  id: string;
  name: string;
  campaign_id: string | null;
  adset_id: string | null;
  ad_id: string | null;
  thumbnail_url: string | null;
  spend: number;
  impressions: number;
  link_clicks: number;
  landing_page_views: number;
  add_to_cart: number;
  purchases: number;
  purchase_value: number;
  sessions: number;
  add_to_cart_sessions: number;
  conversion_sessions: number;
  tracked_value: number;
  /** Meta's own lead count (hub field `leads`). */
  meta_leads: number;
  signup_sessions: number;
  trial_sessions: number;
  demo_sessions: number;
  lead_sessions: number;
  paid_events: number;
  /** Effective counts used by the business-type metrics (tracked when the client has a site, else Meta). */
  leads: number;
  signups: number;
  trials: number;
  demos: number;
  paid: number;
  rates: Rates;
};
export type PerfTotals = Omit<PerfRow, "id" | "name" | "campaign_id" | "adset_id" | "ad_id" | "thumbnail_url">;
type Counts = Pick<PerfRow, "leads" | "signups" | "trials" | "demos" | "paid">;

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : 0);
const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);
const safeUrl = (v: unknown): string | null => {
  if (typeof v !== "string") return null;
  try {
    return new URL(v).protocol === "https:" ? v : null;
  } catch {
    return null;
  }
};

export function validateRange(from: string | null, to: string | null): { from: string; to: string } | null {
  const re = /^\d{4}-\d{2}-\d{2}$/;
  if (!from || !to || !re.test(from) || !re.test(to)) return null;
  const f = new Date(from + "T00:00:00Z");
  const t = new Date(to + "T00:00:00Z");
  if (Number.isNaN(f.getTime()) || Number.isNaN(t.getTime())) return null;
  if (f.toISOString().slice(0, 10) !== from || t.toISOString().slice(0, 10) !== to) return null;
  const days = Math.round((t.getTime() - f.getTime()) / 86_400_000) + 1;
  if (days < 1 || days > 366) return null;
  return { from, to };
}

type Source = { tracking: boolean; roasSource: string; type?: BusinessType };
type Base = Omit<PerfTotals, "rates" | keyof Counts>;

/** Leads/signups: tracked sessions when the client has a site, else Meta's lead count (same pattern as roas_source). */
function effectiveCounts(t: Base, tracking: boolean): Counts {
  return {
    leads: tracking ? t.lead_sessions : t.meta_leads,
    signups: tracking ? t.signup_sessions : t.meta_leads,
    trials: tracking ? t.trial_sessions : 0,
    demos: tracking ? t.demo_sessions : 0,
    paid: tracking ? t.paid_events : 0,
  };
}

function totalsToRates(t: Base, s: Source): Rates {
  const c = effectiveCounts(t, s.tracking);
  const totals: Totals = {
    spend: t.spend,
    impressions: t.impressions,
    linkClicks: t.link_clicks,
    sessions: t.sessions,
    addToCartSessions: t.add_to_cart_sessions,
    conversionSessions: t.conversion_sessions,
    value: s.tracking && s.roasSource === "tracking" ? t.tracked_value : t.purchase_value,
    leads: c.leads,
    signups: c.signups,
    trials: c.trials,
    demos: c.demos,
    paidEvents: c.paid,
  };
  const type = s.type ?? "ecommerce";
  const r = computeRates(totals, type);
  if (!s.tracking) for (const k of TRACKING_ONLY_METRICS[type]) r[k] = null;
  return r;
}

export function normalizeRow(raw: any, s: Source): PerfRow {
  const base = {
    spend: num(raw?.spend),
    impressions: num(raw?.impressions),
    link_clicks: num(raw?.link_clicks),
    landing_page_views: num(raw?.landing_page_views),
    add_to_cart: num(raw?.add_to_cart),
    purchases: num(raw?.purchases),
    purchase_value: num(raw?.purchase_value),
    sessions: num(raw?.sessions),
    add_to_cart_sessions: num(raw?.add_to_cart_sessions),
    conversion_sessions: num(raw?.conversion_sessions),
    tracked_value: num(raw?.tracked_value),
    meta_leads: num(raw?.leads),
    signup_sessions: num(raw?.signup_sessions),
    trial_sessions: num(raw?.trial_sessions),
    demo_sessions: num(raw?.demo_sessions),
    lead_sessions: num(raw?.lead_sessions),
    paid_events: num(raw?.paid_events),
  };
  return {
    id: str(raw?.id) ?? "unknown",
    name: str(raw?.name) ?? "(unnamed)",
    campaign_id: str(raw?.campaign_id),
    adset_id: str(raw?.adset_id),
    ad_id: str(raw?.ad_id),
    thumbnail_url: safeUrl(raw?.thumbnail_url),
    ...base,
    ...effectiveCounts(base, s.tracking),
    rates: totalsToRates(base, s),
  };
}

export function sumRows(rows: PerfRow[], s: Source): PerfTotals {
  const t = {
    spend: 0, impressions: 0, link_clicks: 0, landing_page_views: 0, add_to_cart: 0, purchases: 0,
    purchase_value: 0, sessions: 0, add_to_cart_sessions: 0, conversion_sessions: 0, tracked_value: 0,
    meta_leads: 0, signup_sessions: 0, trial_sessions: 0, demo_sessions: 0, lead_sessions: 0, paid_events: 0,
  };
  for (const r of rows) for (const k of Object.keys(t) as (keyof typeof t)[]) t[k] += r[k];
  return { ...t, ...effectiveCounts(t, s.tracking), rates: totalsToRates(t, s) };
}

export function normalizeUnattributed(raw: any) {
  if (!raw || typeof raw !== "object") return null;
  return {
    sessions: num(raw.sessions),
    add_to_cart_sessions: num(raw.add_to_cart_sessions),
    conversion_sessions: num(raw.conversion_sessions),
    signup_sessions: num(raw.signup_sessions),
    trial_sessions: num(raw.trial_sessions),
    demo_sessions: num(raw.demo_sessions),
    lead_sessions: num(raw.lead_sessions),
    paid_events: num(raw.paid_events),
  };
}
