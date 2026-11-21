"use client";

import { useState } from "react";
import { LEAD_STATUSES, type LeadStatus } from "@/lib/actions/types";

export const LEAD_STATUS_LABEL: Record<LeadStatus, string> = { new: "New", qualified: "Qualified", won: "Won", lost: "Lost" };

export default function LeadStatusSelect({ clientId, sessionId, status, onChanged }: {
  clientId: string; sessionId: string; status: LeadStatus; onChanged?: (s: LeadStatus) => void;
}) {
  const [value, setValue] = useState<LeadStatus>(status);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function change(next: LeadStatus) {
    const prev = value;
    setValue(next);
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/clients/${clientId}/leads`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ session_id: sessionId, status: next }) });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error ?? "Could not save the status.");
      onChanged?.(next);
    } catch (e) {
      setValue(prev);
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <select aria-label="Lead status" value={value} disabled={busy} onChange={(e) => change(e.target.value as LeadStatus)} className="rounded border px-2 py-1 text-sm">
        {LEAD_STATUSES.map((s) => <option key={s} value={s}>{LEAD_STATUS_LABEL[s]}</option>)}
      </select>
      {error && <p role="alert" className="text-xs text-red-700">{error}</p>}
    </div>
  );
}
