"use client";

import { useState } from "react";
import type { LeadsResponse } from "@/lib/actions/types";
import DateRange, { presetRange, type Range } from "../DateRange";
import { formatInt, formatMoney } from "@/lib/format";
import { useApi } from "./useApi";
import TrackingNotSetUp from "./TrackingNotSetUp";
import LeadStatusSelect from "./LeadStatusSelect";

function Card({ label, value, testId }: { label: string; value: string; testId: string }) {
  return (
    <div className="rounded border p-3 shadow-sm">
      <div className="text-xs text-gray-500">{label}</div>
      <div data-testid={testId} className="mt-1 text-xl font-semibold">{value}</div>
    </div>
  );
}

export default function LeadsView({ clientId }: { clientId: string }) {
  const [range, setRange] = useState<Range>(() => presetRange(30));
  const [reload, setReload] = useState(0);
  const { data, error, loading } = useApi<LeadsResponse & { tracking?: boolean }>(
    `/api/clients/${clientId}/leads?from=${range.from}&to=${range.to}`, "Could not load leads.", reload);
  return (
    <div className="space-y-4">
      <DateRange value={range} onChange={setRange} />
      {loading && <p role="status" className="text-sm text-gray-500">Loading...</p>}
      {error && <p role="alert" className="rounded bg-red-50 p-3 text-sm text-red-700">{error}</p>}
      {data && (!loading || reload > 0) && (data.tracking === false ? <TrackingNotSetUp clientId={clientId} what="Website leads" /> : (
        <>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <Card testId="leads-total" label="Leads" value={formatInt(data.total)} />
            <Card testId="leads-qualified" label="Qualified leads" value={formatInt(data.qualified)} />
            <Card testId="cost-per-lead" label="Cost per ad-attributed lead" value={formatMoney(data.cost_per_lead, data.currency)} />
            <Card testId="cost-per-qualified" label="Cost per qualified ad-attributed lead" value={formatMoney(data.cost_per_qualified_lead, data.currency)} />
          </div>
          {data.leads.length === 0 ? (
            <p className="rounded border p-4 text-sm text-gray-600">No website leads in this date range yet.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead><tr className="border-b"><th className="p-2">Date</th><th className="p-2">Ad</th><th className="p-2">Page</th><th className="p-2">Status</th></tr></thead>
                <tbody>
                  {data.leads.map((l) => (
                    <tr key={l.session_id} className="border-b">
                      <td className="p-2">{l.ts.slice(0, 10)}</td>
                      <td className="p-2">{l.ad_name ?? l.ad_id ?? "Unattributed"}</td>
                      <td className="max-w-xs break-all p-2">{l.url ?? "-"}</td>
                      <td className="p-2"><LeadStatusSelect clientId={clientId} sessionId={l.session_id} status={l.status} onChanged={() => setReload((n) => n + 1)} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {data.truncated && <p className="text-xs text-gray-500">Only the most recent leads are shown. Try a shorter range.</p>}
          <p className="text-xs text-gray-500">Only leads from your website tracker are included. Meta Instant Form leads are not included. Statuses are marked by you; costs use leads attributed to an ad (organic leads are excluded); qualified counts Qualified and Won.</p>
        </>
      ))}
    </div>
  );
}
