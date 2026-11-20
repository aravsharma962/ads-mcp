"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { BUSINESS_TYPES, BUSINESS_TYPE_LABELS, type BusinessType } from "@/lib/metrics";

export default function BusinessTypeSelect({ clientId, value, canEdit }: { clientId: string; value: BusinessType; canEdit: boolean }) {
  const router = useRouter();
  const [current, setCurrent] = useState<BusinessType>(value);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function change(next: BusinessType) {
    setBusy(true);
    setError(null);
    const res = await fetch(`/api/clients/${clientId}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ business_type: next }) });
    const data = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok) { setError(data.error ?? "Could not change the business type."); return; }
    setCurrent(next);
    router.refresh();
  }

  return (
    <div className="space-y-1">
      <label className="flex items-center gap-2 text-sm">
        <span className="font-medium">Business type</span>
        <select aria-label="Business type" disabled={!canEdit || busy} value={current} onChange={(e) => void change(e.target.value as BusinessType)} className="rounded border px-3 py-2">
          {BUSINESS_TYPES.map((t) => <option key={t} value={t}>{BUSINESS_TYPE_LABELS[t]}</option>)}
        </select>
      </label>
      <p className="text-xs text-gray-500">Decides which metrics, targets and dashboard columns this client uses. Targets you already saved are kept if you switch back.</p>
      {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
    </div>
  );
}
