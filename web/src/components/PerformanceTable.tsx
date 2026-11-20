import {
  EMPTY_BAND, TRACKING_ONLY_METRICS, hasBand, metricLabel, metricsForType, statusFor,
  type BusinessType, type Rates, type Targets,
} from "@/lib/metrics";
import { STATUS_CLASS } from "./StatusBadge";
import { formatMetric, formatMoney, formatInt } from "@/lib/format";

export type DisplayRow = {
  id: string;
  name: string;
  thumbnail_url: string | null;
  spend: number;
  impressions: number;
  link_clicks: number;
  add_to_cart: number;
  purchases: number;
  purchase_value: number;
  leads?: number;
  signups?: number;
  trials?: number;
  demos?: number;
  paid?: number;
  rates: Rates;
};

type CountKey = "add_to_cart" | "purchases" | "leads" | "signups" | "trials" | "demos" | "paid";
/** Count columns shown after the Meta basics, per business type. `tracked` ones need the first-party tracker. */
const COUNT_COLUMNS: Record<BusinessType, { key: CountKey; label: string; tracked?: boolean }[]> = {
  ecommerce: [{ key: "add_to_cart", label: "Add to cart" }, { key: "purchases", label: "Purchases" }],
  lead_gen: [{ key: "leads", label: "Leads" }],
  saas_b2b: [
    { key: "signups", label: "Signups" },
    { key: "trials", label: "Trials", tracked: true },
    { key: "demos", label: "Demos", tracked: true },
    { key: "paid", label: "Paid", tracked: true },
  ],
};
const LEVEL_LABEL = { campaign: "Campaign", adset: "Ad set", ad: "Ad" } as const;

export default function PerformanceTable({ rows, targets, currency, level, tracking, businessType = "ecommerce" }: {
  rows: DisplayRow[];
  targets: Targets;
  currency: string;
  level: keyof typeof LEVEL_LABEL;
  tracking: boolean;
  businessType?: BusinessType;
}) {
  const metrics = metricsForType(businessType);
  const counts = COUNT_COLUMNS[businessType];
  if (rows.length === 0) {
    return <p className="rounded bg-white p-6 text-center text-gray-600 shadow">No data for this period</p>;
  }
  return (
    <div className="overflow-x-auto rounded bg-white shadow">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b text-left">
            <th className="p-2">{LEVEL_LABEL[level]}</th>
            <th className="p-2">Spend</th>
            <th className="p-2">Impressions</th>
            <th className="p-2">Link clicks</th>
            {counts.map((c) => <th key={c.key} className="p-2">{c.label}</th>)}
            {metrics.map((m) => <th key={m} className="p-2">{metricLabel(businessType, m)}</th>)}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} className="border-b last:border-0">
              <td className="flex items-center gap-2 p-2">
                {r.thumbnail_url && (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={r.thumbnail_url} alt={r.name} width={40} height={40} loading="lazy" referrerPolicy="no-referrer" className="h-10 w-10 rounded object-cover" />
                )}
                <span>{r.name}</span>
              </td>
              <td className="p-2">{formatMoney(r.spend, currency)}</td>
              <td className="p-2">{formatInt(r.impressions)}</td>
              <td className="p-2">{formatInt(r.link_clicks)}</td>
              {counts.map((c) => (
                <td key={c.key} className="p-2">{c.tracked && !tracking ? "-" : formatInt(r[c.key] ?? 0)}</td>
              ))}
              {metrics.map((m) => {
                const untracked = !tracking && TRACKING_ONLY_METRICS[businessType].includes(m);
                const band = targets[m] ?? EMPTY_BAND;
                const status = untracked ? "no_data" : statusFor(m, r.rates[m], band);
                const noTarget = !untracked && typeof r.rates[m] === "number" && !hasBand(band);
                return (
                  <td key={m} data-metric={m} data-status={status} title={noTarget ? "Set a target" : undefined} className={`p-2 ${STATUS_CLASS[status]}`}>
                    {untracked ? "Tracking not set up" : formatMetric(m, r.rates[m], currency)}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
