import type { Verdict } from "@/lib/actions/types";

export const VERDICT_LABEL: Record<Verdict, string> = {
  scale: "Scale",
  keep_watch: "Keep watching",
  too_early: "Too early",
  refresh_creative: "Refresh creative",
  pause: "Pause",
};

export const VERDICT_CLASS: Record<Verdict, string> = {
  scale: "verdict-scale bg-green-50 text-green-800",
  keep_watch: "verdict-keep_watch bg-blue-50 text-blue-800",
  too_early: "verdict-too_early bg-gray-100 text-gray-600",
  refresh_creative: "verdict-refresh_creative bg-amber-50 text-amber-800",
  pause: "verdict-pause bg-red-50 text-red-800",
};

export default function VerdictBadge({ verdict }: { verdict: Verdict }) {
  return <span data-verdict={verdict} className={`rounded px-2 py-0.5 text-xs ${VERDICT_CLASS[verdict]}`}>{VERDICT_LABEL[verdict]}</span>;
}
