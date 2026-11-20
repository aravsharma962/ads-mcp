import type { Status } from "@/lib/metrics";

export const STATUS_LABEL: Record<Status, string> = {
  on_target: "On target",
  better: "Better",
  off_target: "Off target",
  no_data: "No data",
};

export const STATUS_CLASS: Record<Status, string> = {
  on_target: "status-on_target bg-green-50 text-green-800",
  better: "status-better bg-blue-50 text-blue-800",
  off_target: "status-off_target bg-red-50 text-red-800",
  no_data: "status-no_data bg-gray-100 text-gray-500",
};

export default function StatusBadge({ status, label }: { status: Status; label?: string }) {
  return <span className={`rounded px-2 py-0.5 text-xs ${STATUS_CLASS[status]}`}>{label ?? STATUS_LABEL[status]}</span>;
}
