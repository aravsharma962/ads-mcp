"use client";

import { useState } from "react";
import type { PagesResponse } from "@/lib/actions/types";
import DateRange, { presetRange, type Range } from "../DateRange";
import { formatInt } from "@/lib/format";
import { useApi } from "./useApi";
import TrackingNotSetUp from "./TrackingNotSetUp";

const pct = (v: number | null) => (v === null ? "No data" : `${v.toFixed(1)}%`);

export default function PagesView({ clientId }: { clientId: string }) {
  const [range, setRange] = useState<Range>(() => presetRange(7));
  const { data, error, loading } = useApi<PagesResponse & { tracking?: boolean }>(
    `/api/clients/${clientId}/pages?from=${range.from}&to=${range.to}`, "Could not load site pages.");
  return (
    <div className="space-y-4">
      <DateRange value={range} onChange={setRange} />
      {loading && <p role="status" className="text-sm text-gray-500">Loading...</p>}
      {error && <p role="alert" className="rounded bg-red-50 p-3 text-sm text-red-700">{error}</p>}
      {data && !loading && (data.tracking === false ? <TrackingNotSetUp clientId={clientId} what="Site page numbers" /> : (
        <>
          <p className="text-sm text-gray-600">{formatInt(data.sessions)} sessions, {formatInt(data.bounced_sessions)} bounced.</p>
          {data.pages.length === 0 ? (
            <p className="rounded border p-4 text-sm text-gray-600">Not enough data yet for this date range.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead><tr className="border-b"><th className="p-2">Page</th><th className="p-2">Sessions</th><th className="p-2">Exit rate</th><th className="p-2">Bounce rate</th><th className="p-2">Conversions</th></tr></thead>
                <tbody>
                  {data.pages.map((p) => (
                    <tr key={p.url} className="border-b">
                      <td className="max-w-xs break-all p-2">{p.url}</td>
                      <td className="p-2">{formatInt(p.sessions)}</td>
                      <td className="p-2">{pct(p.exit_rate)}</td>
                      <td className="p-2">{pct(p.bounce_rate)}</td>
                      <td className="p-2">{formatInt(p.conversions)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {data.truncated && <p className="text-xs text-gray-500">This range has a lot of events. Only the most recent ones are included, so numbers are partial. Try a shorter range.</p>}
          <section aria-label="Retargeting ideas" className="rounded border p-3">
            <h2 className="font-medium">Retargeting ideas</h2>
            {data.retargeting.length === 0 ? <p className="mt-1 text-sm text-gray-600">No retargeting ideas yet.</p> : (
              <ul className="mt-2 list-disc pl-5 text-sm">{data.retargeting.map((r, i) => <li key={i}>{r.text}</li>)}</ul>
            )}
          </section>
        </>
      ))}
    </div>
  );
}
