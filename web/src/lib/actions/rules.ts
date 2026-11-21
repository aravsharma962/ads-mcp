import { DEFAULT_ACTION_RULES, type ActionRules } from "./types";

const RANGES: Record<keyof ActionRules, [number, number]> = {
  frequency_max: [1, 20],
  ctr_drop_pct: [1, 90],
  cost_rise_pct: [1, 500],
  min_impressions: [100, 1_000_000],
  min_results_scale: [1, 1000],
  scale_better_pct: [1, 90],
  window_days: [3, 30],
  bounce_seconds: [1, 60],
};
const INTEGER_KEYS: (keyof ActionRules)[] = ["window_days"];

/** Missing or invalid keys fall back to the defaults; valid numbers are clamped to the allowed range. */
export function parseActionRules(raw: unknown): ActionRules {
  const out: ActionRules = { ...DEFAULT_ACTION_RULES };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  const src = raw as Record<string, unknown>;
  for (const k of Object.keys(RANGES) as (keyof ActionRules)[]) {
    const v = src[k];
    if (typeof v !== "number" || !Number.isFinite(v)) continue;
    const [lo, hi] = RANGES[k];
    let n = Math.min(hi, Math.max(lo, v));
    if (INTEGER_KEYS.includes(k)) n = Math.min(hi, Math.max(lo, Math.round(n)));
    out[k] = n;
  }
  return out;
}
