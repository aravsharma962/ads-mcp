"use client";

import { useState } from "react";
import type { ActionsResponse } from "@/lib/actions/types";
import { useApi } from "./useApi";
import VerdictChips from "./VerdictChips";
import AdActionsTable from "./AdActionsTable";
import WinnersPanel from "./WinnersPanel";
import RulesForm from "./RulesForm";

export default function ActionsView({ clientId }: { clientId: string }) {
  const [reload, setReload] = useState(0);
  const [editing, setEditing] = useState(false);
  const { data, error, loading } = useApi<ActionsResponse>(`/api/clients/${clientId}/actions`, "Could not load ad actions.", reload);

  return (
    <div className="space-y-4">
      <p className="rounded bg-gray-50 p-3 text-sm text-gray-700">
        These are suggestions only. Nothing is changed in Meta: you decide what to do in Ads Manager.
      </p>
      {loading && <p role="status" className="text-sm text-gray-500">{data ? "Refreshing..." : "Loading..."}</p>}
      {error && <p role="alert" className="rounded bg-red-50 p-3 text-sm text-red-700">{error}</p>}
      {data && (
        <>
          <p className="text-sm text-gray-600">
            Last {data.rules.window_days} days ({data.windows.recent.from} to {data.windows.recent.to}) compared with the {data.rules.window_days} days before.
          </p>
          <VerdictChips counts={data.counts} />
          <AdActionsTable actions={data.actions} currency={data.currency} resultLabel={data.result_label} />
          <WinnersPanel winners={data.winners} currency={data.currency} />
          <div className="space-y-2">
            <button type="button" onClick={() => setEditing((e) => !e)} aria-expanded={editing} className="rounded border px-3 py-1 text-sm">
              {editing ? "Close rules" : "Edit rules"}
            </button>
            {editing && <RulesForm clientId={clientId} initial={data.rules} onSaved={() => { setReload((n) => n + 1); }} />}
          </div>
        </>
      )}
    </div>
  );
}
