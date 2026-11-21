"use client";

import type { ReportResponse } from "@/lib/actions/types";
import { formatInt, formatMoney } from "@/lib/format";
import { useApi } from "./useApi";
import CopyButton from "./CopyButton";
import AdActionsTable from "./AdActionsTable";
import { STATUS_CLASS, STATUS_LABEL } from "../StatusBadge";

function Card({ label, value, prev }: { label: string; value: string; prev?: string }) {
  return (
    <div className="rounded border p-3 shadow-sm">
      <div className="text-xs text-gray-500">{label}</div>
      <div className="mt-1 text-xl font-semibold">{value}</div>
      {prev && <div className="text-xs text-gray-500">Before: {prev}</div>}
    </div>
  );
}

export default function ReportView({ clientId }: { clientId: string }) {
  const { data, error, loading } = useApi<ReportResponse>(`/api/clients/${clientId}/report`, "Could not load the report.");
  return (
    <div className="space-y-4">
      {loading && <p role="status" className="text-sm text-gray-500">Loading...</p>}
      {error && <p role="alert" className="rounded bg-red-50 p-3 text-sm text-red-700">{error}</p>}
      {data && !loading && (() => {
        const c = data.currency;
        const { recent: r, previous: p } = data;
        return (
          <>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <h2 className="text-lg font-medium">Report for {data.client_name}</h2>
                <p className="text-sm text-gray-600">{data.windows.recent.from} to {data.windows.recent.to}, compared with {data.windows.previous.from} to {data.windows.previous.to}</p>
              </div>
              <div className="flex gap-2 print:hidden">
                <CopyButton text={data.whatsapp_text} label="Copy WhatsApp text" />
                <button type="button" onClick={() => window.print()} className="rounded border px-3 py-1 text-sm">Print</button>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
              <Card label="Spend" value={formatMoney(r.spend, c)} prev={formatMoney(p.spend, c)} />
              <Card label="Results" value={formatInt(r.results)} prev={formatInt(p.results)} />
              <Card label="Cost per result" value={formatMoney(r.cost_per_result, c)} prev={formatMoney(p.cost_per_result, c)} />
              <Card label="CTR" value={r.ctr === null ? "no data" : `${r.ctr.toFixed(2)}%`} prev={p.ctr === null ? "no data" : `${p.ctr.toFixed(2)}%`} />
            </div>
            <section aria-label="Target checks" className="break-inside-avoid">
              <h3 className="mb-2 font-medium">Target checks</h3>
              {data.target_checks.length === 0 ? <p className="text-sm text-gray-600">No targets set yet.</p> : (
                <ul className="grid gap-2 md:grid-cols-2">
                  {data.target_checks.map((t) => (
                    <li key={t.metric} data-status={t.status} className={`flex justify-between rounded border p-2 text-sm ${STATUS_CLASS[t.status]}`}>
                      <span>{t.label}</span>
                      <span>{t.value === null ? "no data" : t.value.toFixed(2)} - {STATUS_LABEL[t.status]}</span>
                    </li>
                  ))}
                </ul>
              )}
            </section>
            <section aria-label="Top ads" className="break-inside-avoid">
              <h3 className="mb-2 font-medium">Top ads</h3>
              {data.top_ads.length === 0 ? <p className="text-sm text-gray-600">Not enough data yet.</p> : <AdActionsTable actions={data.top_ads} currency={c} resultLabel="result" />}
            </section>
            <section aria-label="Bottom ads" className="break-inside-avoid">
              <h3 className="mb-2 font-medium">Bottom ads</h3>
              {data.bottom_ads.length === 0 ? <p className="text-sm text-gray-600">Not enough data yet.</p> : <AdActionsTable actions={data.bottom_ads} currency={c} resultLabel="result" />}
            </section>
            <section aria-label="Next actions" className="break-inside-avoid">
              <h3 className="mb-2 font-medium">Next actions</h3>
              {data.next_actions.length === 0 ? <p className="text-sm text-gray-600">No actions suggested.</p> : (
                <ol className="list-decimal pl-5 text-sm">{data.next_actions.map((a, i) => <li key={i}>{a}</li>)}</ol>
              )}
            </section>
            <p className="text-xs text-gray-500">Suggestions only. Nothing is changed in Meta.</p>
          </>
        );
      })()}
    </div>
  );
}
