import type { MetricKey } from "./metrics";

export function formatInt(n: number): string {
  return Number.isFinite(n) ? Math.round(n).toLocaleString("en-US") : "0";
}

export function formatMoney(n: number | null, currency: string): string {
  if (n === null || !Number.isFinite(n)) return "no data";
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency, maximumFractionDigits: 2 }).format(n);
  } catch {
    return `${n.toFixed(2)} ${currency}`;
  }
}

/** Null or non-finite values always read "no data", never NaN or Infinity. */
const MONEY_METRICS: MetricKey[] = ["cpc", "cpm", "cpl", "cost_per_trial", "cac"];
export function formatMetric(m: MetricKey, v: number | null | undefined, currency: string): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "no data";
  if (MONEY_METRICS.includes(m)) return formatMoney(v, currency);
  if (m === "roas") return `${v.toFixed(2)}x`;
  return `${v.toFixed(2)}%`;
}
