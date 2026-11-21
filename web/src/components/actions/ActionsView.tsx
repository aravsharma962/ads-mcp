"use client";

import { useState } from "react";
import type { ActionsResponse, AdAction, ApplyAction, ApplyLogResponse, ApplyResponse } from "@/lib/actions/types";
import { useApi } from "./useApi";
import VerdictChips from "./VerdictChips";
import AdActionsTable from "./AdActionsTable";
import WinnersPanel from "./WinnersPanel";
import RulesForm from "./RulesForm";
import ApplyConfirm from "./ApplyConfirm";
import ChangeLog from "./ChangeLog";

export default function ActionsView({ clientId, isOwner = false }: { clientId: string; isOwner?: boolean }) {
  const [reload, setReload] = useState(0);
  const [editing, setEditing] = useState(false);
  const { data, error, loading } = useApi<ActionsResponse>(`/api/clients/${clientId}/actions`, "Could not load ad actions.", reload);
  const applyUrl = `/api/clients/${clientId}/apply`;
  const { data: applyData } = useApi<ApplyLogResponse>(applyUrl, "Could not load recent changes.", reload);
  const [pending, setPending] = useState<{ ad: AdAction; action: ApplyAction } | null>(null);
  const [busy, setBusy] = useState(false);
  const [applyError, setApplyError] = useState<string | null>(null);
  const [applyNote, setApplyNote] = useState<string | null>(null);
  const writesEnabled = applyData?.writes_enabled === true;
  const log = Array.isArray(applyData?.log) ? applyData.log : [];

  async function confirmApply() {
    if (!pending || busy) return;
    setBusy(true);
    setApplyError(null);
    try {
      const res = await fetch(applyUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ad_id: pending.ad.ad_id, action: pending.action }) });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error ?? "Could not apply the change.");
      setApplyNote((body as ApplyResponse).note);
      setPending(null);
      setReload((n) => n + 1);
    } catch (e) {
      setApplyError(e instanceof Error ? e.message : "Could not apply the change.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <p className="rounded bg-gray-50 p-3 text-sm text-gray-700">
        {writesEnabled
          ? "Verdicts are suggestions. The buttons below change your live Meta ad account, and only after you confirm."
          : "These are suggestions only. Nothing is changed in Meta: you decide what to do in Ads Manager."}
      </p>
      {applyData && !writesEnabled && (
        <p role="status" className="rounded bg-amber-50 p-3 text-sm text-amber-900">Changes in Meta are not enabled on this platform yet. Apply buttons stay disabled.</p>
      )}
      {applyNote && <p role="status" className="rounded bg-green-50 p-3 text-sm text-green-800">{applyNote}</p>}
      {loading && <p role="status" className="text-sm text-gray-500">{data ? "Refreshing..." : "Loading..."}</p>}
      {error && <p role="alert" className="rounded bg-red-50 p-3 text-sm text-red-700">{error}</p>}
      {data && (
        <>
          <p className="text-sm text-gray-600">
            Last {data.rules.window_days} days ({data.windows.recent.from} to {data.windows.recent.to}) compared with the {data.rules.window_days} days before.
          </p>
          <VerdictChips counts={data.counts} />
          <AdActionsTable actions={data.actions} currency={data.currency} resultLabel={data.result_label}
            apply={applyData ? { isOwner, writesEnabled, log, onApply: (ad, action) => { setApplyError(null); setApplyNote(null); setPending({ ad, action }); } } : undefined} />
          {applyData && <ChangeLog log={log} />}
          <WinnersPanel winners={data.winners} currency={data.currency} />
          <div className="space-y-2">
            <button type="button" onClick={() => setEditing((e) => !e)} aria-expanded={editing} className="rounded border px-3 py-1 text-sm">
              {editing ? "Close rules" : "Edit rules"}
            </button>
            {editing && <RulesForm clientId={clientId} initial={data.rules} onSaved={() => { setReload((n) => n + 1); }} />}
          </div>
        </>
      )}
      {pending && (
        <ApplyConfirm adName={pending.ad.name} action={pending.action} busy={busy} error={applyError}
          onConfirm={confirmApply} onCancel={() => { if (!busy) { setPending(null); setApplyError(null); } }} />
      )}
    </div>
  );
}
