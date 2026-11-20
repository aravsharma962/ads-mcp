"use client";

import { useEffect, useState } from "react";
import DateRange, { presetRange, type Range } from "./DateRange";
import KpiCard from "./KpiCard";
import PerformanceTable, { type DisplayRow } from "./PerformanceTable";
import { formatMetric } from "@/lib/format";
import {
  EMPTY_BAND, TRACKING_ONLY_METRICS, hasBand, metricDefinition, metricLabel, metricsForType, statusFor,
  type BusinessType, type Rates, type Targets,
} from "@/lib/metrics";

type Level = "campaign" | "adset" | "ad";
type Data = {
  currency: string; tracking: boolean; attribution: string;
  rows: DisplayRow[]; totals: { rates: Rates };
  unattributed: { sessions: number } | null;
};

export default function Dashboard({ clientId, targets, businessType = "ecommerce" }: { clientId: string; targets: Targets; businessType?: BusinessType }) {
  const [range, setRange] = useState<Range>(() => presetRange(7));
  const [level, setLevel] = useState<Level>("campaign");
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const ctl = new AbortController();
    setLoading(true);
    setError(null);
    fetch(`/api/clients/${clientId}/performance?from=${range.from}&to=${range.to}&level=${level}`, { signal: ctl.signal })
      .then(async (res) => {
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(body.error ?? "Could not load performance data.");
        setData(body);
      })
      .catch((e) => { if (e.name !== "AbortError") { setData(null); setError(e.message); } })
      .finally(() => { if (!ctl.signal.aborted) setLoading(false); });
    return () => ctl.abort();
  }, [clientId, range, level]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <DateRange value={range} onChange={setRange} />
        <div role="group" aria-label="Level" className="flex overflow-hidden rounded border text-sm">
          {([["campaign", "Campaign"], ["adset", "Ad set"], ["ad", "Ad"]] as const).map(([v, l]) => (
            <button key={v} onClick={() => setLevel(v)} aria-pressed={level === v} className={`px-3 py-1 ${level === v ? "bg-black text-white" : "bg-white"}`}>{l}</button>
          ))}
        </div>
      </div>
      {loading && <p role="status" className="text-sm text-gray-500">Loading...</p>}
      {error && <p role="alert" className="rounded bg-red-50 p-3 text-sm text-red-700">{error}</p>}
      {data && !loading && (
        <>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            {metricsForType(businessType).map((m) => {
              const untracked = !data.tracking && TRACKING_ONLY_METRICS[businessType].includes(m);
              const band = targets[m] ?? EMPTY_BAND;
              const value = data.totals.rates[m];
              const noTarget = !untracked && typeof value === "number" && !hasBand(band);
              return (
                <KpiCard key={m} label={metricLabel(businessType, m)}
                  value={untracked ? "Tracking not set up" : formatMetric(m, value, data.currency)}
                  status={untracked ? "no_data" : statusFor(m, value, band)}
                  hint={noTarget ? "Set a target" : undefined}
                  definition={`${metricDefinition(businessType, m)} Attribution window: ${data.attribution}.`} />
              );
            })}
          </div>
          <PerformanceTable rows={data.rows} targets={targets} currency={data.currency} level={level} tracking={data.tracking} businessType={businessType} />
          {data.unattributed && data.unattributed.sessions > 0 && (
            <p className="text-sm text-gray-600">Unattributed sessions (no ad id in the URL): {data.unattributed.sessions}.</p>
          )}
          <p className="text-xs text-gray-500">
            Tracked numbers can differ from Meta Ads Manager (ad blockers, missing URL parameters, consent choices). Ads without URL parameters appear as unattributed.
          </p>
        </>
      )}
    </div>
  );
}
