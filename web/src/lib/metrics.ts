export type MetricKey = "ctr" | "cpc" | "cpm" | "visit_rate" | "add_to_cart_rate" | "conversion_rate" | "roas";
export type Status = "on_target" | "better" | "off_target" | "no_data";
export type Band = { min: number | null; max: number | null };

export const METRIC_KEYS: MetricKey[] = ["ctr", "cpc", "cpm", "visit_rate", "add_to_cart_rate", "conversion_rate", "roas"];

export const DEFAULT_TARGETS: Record<MetricKey, Band> = {
  ctr: { min: 3, max: null },
  cpc: { min: null, max: 20 },
  cpm: { min: 13, max: 14 },
  add_to_cart_rate: { min: 14, max: 16 },
  conversion_rate: { min: 10, max: 12 },
  roas: { min: 9, max: 12 },
  visit_rate: { min: 80, max: null },
};

export const DIRECTION: Record<MetricKey, "higher" | "lower"> = {
  ctr: "higher",
  cpc: "lower",
  cpm: "lower",
  visit_rate: "higher",
  add_to_cart_rate: "higher",
  conversion_rate: "higher",
  roas: "higher",
};

export const METRIC_LABELS: Record<MetricKey, string> = {
  ctr: "CTR (%)",
  cpc: "CPC",
  cpm: "CPM",
  visit_rate: "Website visit rate (%)",
  add_to_cart_rate: "Add-to-cart rate (%)",
  conversion_rate: "Conversion rate (%)",
  roas: "ROAS (x)",
};

export const METRIC_DEFINITIONS: Record<MetricKey, string> = {
  ctr: "Link clicks / impressions. Meta attribution: ad account default.",
  cpc: "Spend / link clicks.",
  cpm: "Spend / impressions x 1000.",
  visit_rate: "Unique ad-attributed sessions seen by the tracker / link clicks.",
  add_to_cart_rate: "Unique ad-attributed sessions with an add_to_cart event / link clicks.",
  conversion_rate: "Unique ad-attributed sessions with a conversion event / link clicks.",
  roas: "Tracked purchase value / spend (or Meta's own ROAS, per client setting).",
};

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

export function statusFor(metric: MetricKey, value: number | null, band: Band): Status {
  if (!isNum(value)) return "no_data";
  const { min, max } = band;
  if (min === null && max === null) return "no_data";
  if (DIRECTION[metric] === "higher") {
    if (min !== null && value < min) return "off_target";
    if (max !== null && value > max) return "better";
    return "on_target";
  }
  if (max !== null && value > max) return "off_target";
  if (min !== null && value < min) return "better";
  return "on_target";
}

export type Totals = {
  spend: number;
  impressions: number;
  linkClicks: number;
  sessions: number;
  addToCartSessions: number;
  conversionSessions: number;
  value: number;
};
export type Rates = Record<MetricKey, number | null>;

function ratio(num: number, den: number, mult = 1): number | null {
  if (!isNum(num) || !isNum(den) || den === 0) return null;
  const r = (num / den) * mult;
  return Number.isFinite(r) ? r : null;
}

export function computeRates(t: Totals): Rates {
  return {
    ctr: ratio(t.linkClicks, t.impressions, 100),
    cpc: ratio(t.spend, t.linkClicks),
    cpm: ratio(t.spend, t.impressions, 1000),
    visit_rate: ratio(t.sessions, t.linkClicks, 100),
    add_to_cart_rate: ratio(t.addToCartSessions, t.linkClicks, 100),
    conversion_rate: ratio(t.conversionSessions, t.linkClicks, 100),
    roas: ratio(t.value, t.spend),
  };
}
