import { METRIC_KEYS, METRIC_LABELS, statusFor, type Band, type MetricKey, type Rates } from "@/lib/metrics";
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
  rates: Rates;
};

const TRACKING_METRICS: MetricKey[] = ["visit_rate", "add_to_cart_rate", "conversion_rate"];
const LEVEL_LABEL = { campaign: "Campaign", adset: "Ad set", ad: "Ad" } as const;

export default function PerformanceTable({ rows, targets, currency, level, tracking }: {
  rows: DisplayRow[];
  targets: Record<MetricKey, Band>;
  currency: string;
  level: keyof typeof LEVEL_LABEL;
  tracking: boolean;
}) {
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
            <th className="p-2">Add to cart</th>
            <th className="p-2">Purchases</th>
            {METRIC_KEYS.map((m) => <th key={m} className="p-2">{METRIC_LABELS[m]}</th>)}
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
              <td className="p-2">{formatInt(r.add_to_cart)}</td>
              <td className="p-2">{formatInt(r.purchases)}</td>
              {METRIC_KEYS.map((m) => {
                const untracked = !tracking && TRACKING_METRICS.includes(m);
                const status = untracked ? "no_data" : statusFor(m, r.rates[m], targets[m]);
                return (
                  <td key={m} data-metric={m} data-status={status} className={`p-2 ${STATUS_CLASS[status]}`}>
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
