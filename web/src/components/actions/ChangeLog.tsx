import type { ActionLogRow } from "@/lib/actions/types";
import { APPLY_LABEL } from "./ApplyConfirm";

export default function ChangeLog({ log }: { log: ActionLogRow[] }) {
  return (
    <section aria-label="Recent changes" className="space-y-2">
      <h2 className="text-base font-semibold">Recent changes</h2>
      {log.length === 0 ? (
        <p className="text-sm text-gray-600">No changes made from here yet.</p>
      ) : (
        <ul className="divide-y rounded border text-sm">
          {log.map((r) => (
            <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 p-2">
              <span>
                <span className="font-medium">{APPLY_LABEL[r.action]}</span>: {r.ad_name ?? r.ad_id}
                {(r.status === "error" || r.status === "unknown") && r.error && <span className="block text-red-700">{r.error}</span>}
              </span>
              <span className="flex items-center gap-2 text-xs text-gray-500">
                <span className={r.status === "ok" ? "rounded bg-green-50 px-2 py-0.5 text-green-800" : r.status === "error" ? "rounded bg-red-50 px-2 py-0.5 text-red-800" : "rounded bg-amber-50 px-2 py-0.5 text-amber-800"}>
                  {r.status === "ok" ? "Applied" : r.status === "error" ? "Failed" : r.status === "unknown" ? "Check in Meta" : "In progress"}
                </span>
                <time dateTime={r.created_at}>{new Date(r.created_at).toLocaleString()}</time>
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
