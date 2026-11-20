import type { Status } from "@/lib/metrics";
import StatusBadge, { STATUS_CLASS } from "./StatusBadge";

export default function KpiCard({ label, value, status, definition }: {
  label: string; value: string; status: Status; definition: string;
}) {
  return (
    <div data-status={status} className={`group relative rounded border p-3 shadow-sm ${STATUS_CLASS[status]}`}>
      <div className="flex items-center justify-between text-xs">
        <span>{label}</span>
        <span tabIndex={0} aria-label={`Definition of ${label}`} title={definition} className="cursor-help rounded-full border px-1.5">?</span>
      </div>
      <div className="mt-1 text-xl font-semibold">{value}</div>
      <div className="mt-1"><StatusBadge status={status} /></div>
      <span role="tooltip" className="pointer-events-none absolute left-0 top-full z-10 hidden w-56 rounded bg-black p-2 text-xs text-white group-hover:block group-focus-within:block">
        {definition}
      </span>
    </div>
  );
}
