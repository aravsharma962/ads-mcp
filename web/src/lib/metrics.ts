export const BUSINESS_TYPES = ["lead_gen", "saas_b2b", "ecommerce"] as const;
export type BusinessType = (typeof BUSINESS_TYPES)[number];

export const BUSINESS_TYPE_LABELS: Record<BusinessType, string> = {
  lead_gen: "Lead Generation (clinics, real estate)",
  saas_b2b: "SaaS / B2B Leads",
  ecommerce: "E-commerce",
};

/** Anything that is not a known type (missing column, bad data) is treated as e-commerce. */
export function normalizeBusinessType(v: unknown): BusinessType {
  return (BUSINESS_TYPES as readonly unknown[]).includes(v) ? (v as BusinessType) : "ecommerce";
}

export type MetricKey =
  | "ctr" | "cpc" | "cpm"
  | "visit_rate" | "add_to_cart_rate" | "conversion_rate" | "roas"
  | "cpl" | "lead_rate"
  | "signup_rate" | "demo_rate" | "cost_per_trial" | "cac";
export type Status = "on_target" | "better" | "off_target" | "no_data";
export type Band = { min: number | null; max: number | null };
export type Targets = Partial<Record<MetricKey, Band>>;

export const EMPTY_BAND: Band = { min: null, max: null };
export const hasBand = (b: Band | undefined): boolean => !!b && (b.min !== null || b.max !== null);

export const ALL_METRIC_KEYS: MetricKey[] = [
  "ctr", "cpc", "cpm", "visit_rate", "add_to_cart_rate", "conversion_rate", "roas",
  "cpl", "lead_rate", "signup_rate", "demo_rate", "cost_per_trial", "cac",
];

const METRICS_BY_TYPE: Record<BusinessType, MetricKey[]> = {
  ecommerce: ["ctr", "cpc", "cpm", "visit_rate", "add_to_cart_rate", "conversion_rate", "roas"],
  lead_gen: ["ctr", "cpc", "cpm", "cpl", "lead_rate"],
  saas_b2b: ["ctr", "cpc", "cpm", "cpl", "signup_rate", "demo_rate", "cost_per_trial", "cac"],
};
export const metricsForType = (type: BusinessType): MetricKey[] => [...METRICS_BY_TYPE[type]];

/** Metrics that need the first-party tracker (no site: shown as "Tracking not set up"). */
export const TRACKING_ONLY_METRICS: Record<BusinessType, MetricKey[]> = {
  ecommerce: ["visit_rate", "add_to_cart_rate", "conversion_rate"],
  lead_gen: [],
  saas_b2b: ["demo_rate", "cost_per_trial", "cac"],
};

export const DEFAULT_TARGETS: Record<MetricKey, Band> = {
  ctr: { min: 3, max: null },
  cpc: { min: null, max: 20 },
  cpm: { min: 13, max: 14 },
  add_to_cart_rate: { min: 14, max: 16 },
  conversion_rate: { min: 10, max: 12 },
  roas: { min: 9, max: 12 },
  visit_rate: { min: 80, max: null },
  // New business-type metrics start with no target: the user decides.
  cpl: { min: null, max: null },
  lead_rate: { min: null, max: null },
  signup_rate: { min: null, max: null },
  demo_rate: { min: null, max: null },
  cost_per_trial: { min: null, max: null },
  cac: { min: null, max: null },
};

export function defaultTargetsFor(type: BusinessType): Record<string, Band> {
  const out: Record<string, Band> = {};
  for (const k of METRICS_BY_TYPE[type]) out[k] = { ...DEFAULT_TARGETS[k] };
  return out;
}

export const DIRECTION: Record<MetricKey, "higher" | "lower"> = {
  ctr: "higher",
  cpc: "lower",
  cpm: "lower",
  visit_rate: "higher",
  add_to_cart_rate: "higher",
  conversion_rate: "higher",
  roas: "higher",
  cpl: "lower",
  lead_rate: "higher",
  signup_rate: "higher",
  demo_rate: "higher",
  cost_per_trial: "lower",
  cac: "lower",
};

export const METRIC_LABELS: Record<MetricKey, string> = {
  ctr: "CTR (%)",
  cpc: "CPC",
  cpm: "CPM",
  visit_rate: "Website visit rate (%)",
  add_to_cart_rate: "Add-to-cart rate (%)",
  conversion_rate: "Conversion rate (%)",
  roas: "ROAS (x)",
  cpl: "Cost per lead (CPL)",
  lead_rate: "Lead rate (%)",
  signup_rate: "Signup rate (%)",
  demo_rate: "Demo rate (%)",
  cost_per_trial: "Cost per trial",
  cac: "CAC",
};

export const METRIC_DEFINITIONS: Record<MetricKey, string> = {
  ctr: "Link clicks / impressions. Meta attribution: ad account default.",
  cpc: "Spend / link clicks.",
  cpm: "Spend / impressions x 1000.",
  visit_rate: "Unique ad-attributed sessions seen by the tracker / link clicks.",
  add_to_cart_rate: "Unique ad-attributed sessions with an add_to_cart event / link clicks.",
  conversion_rate: "Unique ad-attributed sessions with a conversion event / link clicks.",
  roas: "Tracked purchase value / spend (or Meta's own ROAS, per client setting).",
  cpl: "Spend / leads. Leads are tracked lead or form_submit sessions when the client has tracking, otherwise Meta's lead count.",
  lead_rate: "Leads / link clicks. Leads are tracked lead or form_submit sessions when the client has tracking, otherwise Meta's lead count.",
  signup_rate: "Signups / link clicks. Signups are unique tracked sessions with a signup event, or Meta's lead count when there is no tracking.",
  demo_rate: "Unique ad-attributed sessions with a demo_booked event / link clicks. Needs tracking.",
  cost_per_trial: "Spend / unique ad-attributed sessions with a trial_start event. Needs tracking.",
  cac: "Spend / number of paid events (customer acquisition cost). Needs tracking.",
};

/** SaaS counts signups, not leads, in the CPL slot. Everything else is shared across types. */
const LABEL_OVERRIDES: Partial<Record<BusinessType, Partial<Record<MetricKey, string>>>> = {
  saas_b2b: { cpl: "Cost per signup (CPL)" },
};
const DEFINITION_OVERRIDES: Partial<Record<BusinessType, Partial<Record<MetricKey, string>>>> = {
  saas_b2b: { cpl: "Spend / signups (cost per signup). Signups are unique tracked sessions with a signup event, or Meta's lead count when there is no tracking." },
};
export const metricLabel = (type: BusinessType, k: MetricKey): string => LABEL_OVERRIDES[type]?.[k] ?? METRIC_LABELS[k];
export const metricDefinition = (type: BusinessType, k: MetricKey): string => DEFINITION_OVERRIDES[type]?.[k] ?? METRIC_DEFINITIONS[k];

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

export function statusFor(metric: MetricKey, value: number | null | undefined, band: Band): Status {
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
  /** Effective counts for the business-type metrics (the caller picks tracked vs Meta source). */
  leads?: number;
  signups?: number;
  trials?: number;
  demos?: number;
  paidEvents?: number;
};
export type Rates = Partial<Record<MetricKey, number | null>>;

function ratio(num: number | undefined, den: number | undefined, mult = 1): number | null {
  if (!isNum(num) || !isNum(den) || den === 0) return null;
  const r = (num / den) * mult;
  return Number.isFinite(r) ? r : null;
}

/** Rates come from summed totals, never from averaging rows. Only the type's own metrics are returned. */
export function computeRates(t: Totals, type: BusinessType = "ecommerce"): Rates {
  const common = {
    ctr: ratio(t.linkClicks, t.impressions, 100),
    cpc: ratio(t.spend, t.linkClicks),
    cpm: ratio(t.spend, t.impressions, 1000),
  };
  if (type === "lead_gen") {
    return { ...common, cpl: ratio(t.spend, t.leads), lead_rate: ratio(t.leads, t.linkClicks, 100) };
  }
  if (type === "saas_b2b") {
    return {
      ...common,
      cpl: ratio(t.spend, t.signups),
      signup_rate: ratio(t.signups, t.linkClicks, 100),
      demo_rate: ratio(t.demos, t.linkClicks, 100),
      cost_per_trial: ratio(t.spend, t.trials),
      cac: ratio(t.spend, t.paidEvents),
    };
  }
  return {
    ...common,
    visit_rate: ratio(t.sessions, t.linkClicks, 100),
    add_to_cart_rate: ratio(t.addToCartSessions, t.linkClicks, 100),
    conversion_rate: ratio(t.conversionSessions, t.linkClicks, 100),
    roas: ratio(t.value, t.spend),
  };
}
