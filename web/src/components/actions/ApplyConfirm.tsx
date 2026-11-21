"use client";

import type { ApplyAction } from "@/lib/actions/types";

export const APPLY_LABEL: Record<ApplyAction, string> = {
  pause: "Pause in Meta",
  scale: "Raise budget 20%",
  resume: "Resume",
};

export function describeChange(action: ApplyAction, adName: string): string {
  switch (action) {
    case "pause":
      return `Pause ad "${adName}" in your live Meta account. It stops delivering and spending. You can resume it later.`;
    case "scale":
      return `Raise the daily budget that runs ad "${adName}" by 20% in your live Meta account (ad set budget, or campaign budget if that is where the budget is set). Budgets can be raised once every 3 days per ad.`;
    case "resume":
      return `Resume ad "${adName}" in your live Meta account. It starts delivering and spending again.`;
  }
}

export default function ApplyConfirm({ adName, action, busy, error, onConfirm, onCancel }: {
  adName: string; action: ApplyAction; busy: boolean; error: string | null; onConfirm: () => void; onCancel: () => void;
}) {
  return (
    <div role="dialog" aria-modal="true" aria-label={`Confirm: ${APPLY_LABEL[action]}`} className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-md space-y-3 rounded bg-white p-4 shadow">
        <h2 className="text-lg font-semibold">{APPLY_LABEL[action]}</h2>
        <p className="text-sm text-gray-800">{describeChange(action, adName)}</p>
        <p className="rounded bg-amber-50 p-2 text-sm text-amber-900">This changes the live Meta ad account, not just this dashboard.</p>
        {error && <p role="alert" className="rounded bg-red-50 p-2 text-sm text-red-700">{error}</p>}
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onCancel} disabled={busy} className="rounded border px-3 py-1 text-sm">Cancel</button>
          <button type="button" onClick={onConfirm} disabled={busy} className="rounded bg-black px-3 py-1 text-sm text-white disabled:opacity-50">
            {busy ? "Applying..." : "Confirm change in Meta"}
          </button>
        </div>
      </div>
    </div>
  );
}
