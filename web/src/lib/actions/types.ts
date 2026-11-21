/** Phase A contract: shared types for the Actions, Report, Pages and Leads features. Pure types + defaults only. */
import type { BusinessType } from "@/lib/metrics";

export const VERDICTS = ["too_early", "keep_watch", "scale", "refresh_creative", "pause"] as const;
export type Verdict = (typeof VERDICTS)[number];
export type Confidence = "low" | "medium" | "high";

/** Per-client thresholds, stored in clients.action_rules (jsonb). Values from the "Meta Ads MCP" video: frequency 3, CTR drop 25%, cost per result rise 15%. */
export type ActionRules = {
  frequency_max: number;      // frequency at or above this is a fatigue signal
  ctr_drop_pct: number;       // CTR fell by more than this % vs the previous window
  cost_rise_pct: number;      // cost per result rose by more than this % vs the previous window
  min_impressions: number;    // below this in the recent window: "too_early"
  min_results_scale: number;  // results needed before "scale" can be suggested
  scale_better_pct: number;   // with no target set: scale when cost per result is this % cheaper than the account average
  window_days: number;        // recent window length; the previous window has the same length right before it
  bounce_seconds: number;     // a visit shorter than this on a single page counts as a bounce
};
export const DEFAULT_ACTION_RULES: ActionRules = {
  frequency_max: 3, ctr_drop_pct: 25, cost_rise_pct: 15, min_impressions: 1000,
  min_results_scale: 5, scale_better_pct: 20, window_days: 7, bounce_seconds: 10,
};

export type PeriodStats = {
  spend: number; impressions: number; link_clicks: number; results: number;
  frequency: number | null; ctr: number | null; cost_per_result: number | null;
};

export type AdAction = {
  ad_id: string; name: string; thumbnail_url: string | null; campaign_id: string | null; adset_id: string | null;
  verdict: Verdict; confidence: Confidence;
  reasons: string[];                     // plain English, with the real numbers
  signals: { frequency: boolean; ctr_drop: boolean; cost_rise: boolean };
  recent: PeriodStats; previous: PeriodStats;
  suggestion: string;                    // e.g. "Raise budget by at most 20%, then wait 3 days."
};

export type ActionsResponse = {
  currency: string; business_type: BusinessType; result_label: string;   // "purchase" | "lead" | "signup"
  rules: ActionRules;
  windows: { recent: { from: string; to: string }; previous: { from: string; to: string } };
  actions: AdAction[];                   // all ads, worst verdicts first
  winners: AdAction[];                   // "Copy winners" candidates, best first
  counts: Record<Verdict, number>;
  ad_account?: boolean;                  // false when the client has no ad account connected (empty lists, not an error)
};

export type ReportResponse = {
  currency: string; business_type: BusinessType; client_name: string;
  windows: ActionsResponse["windows"];
  recent: PeriodStats; previous: PeriodStats;
  target_checks: { metric: string; label: string; value: number | null; status: "on_target" | "better" | "off_target" | "no_data" }[];
  top_ads: AdAction[]; bottom_ads: AdAction[];
  next_actions: string[];
  whatsapp_text: string;                 // plain text the agency can copy into WhatsApp
  ad_account?: boolean;                  // false when the client has no ad account connected
};

export type PageStat = {
  url: string; sessions: number; exits: number; exit_rate: number | null;
  bounces: number; bounce_rate: number | null; conversions: number;
};
export type RetargetSuggestion = { url: string; ad_id: string | null; ad_name: string | null; visitors: number; text: string };
export type PagesResponse = {
  window: { from: string; to: string }; sessions: number; bounced_sessions: number;
  pages: PageStat[]; retargeting: RetargetSuggestion[]; truncated: boolean;
  tracking: boolean;                     // false when the client has no tracker site (lists are empty)
};

export const LEAD_STATUSES = ["new", "qualified", "won", "lost"] as const;
export type LeadStatus = (typeof LEAD_STATUSES)[number];
export type LeadRow = { session_id: string; ts: string; ad_id: string | null; ad_name: string | null; url: string | null; status: LeadStatus };
export type LeadsResponse = {
  window: { from: string; to: string }; currency: string;
  leads: LeadRow[]; total: number;
  attributed_total?: number;             // leads with an ad_id; cost metrics are computed from these only
  qualified: number; won: number;
  spend: number; cost_per_lead: number | null; cost_per_qualified_lead: number | null; truncated: boolean;
  tracking: boolean;                     // false when the client has no tracker site (list is empty)
  ad_account?: boolean;                  // false when no ad account is connected: spend is 0 and costs are null
};
