import { VERDICTS, type Verdict } from "@/lib/actions/types";
import { VERDICT_CLASS, VERDICT_LABEL } from "./VerdictBadge";

export default function VerdictChips({ counts }: { counts: Record<Verdict, number> }) {
  return (
    <ul aria-label="Verdict counts" className="flex flex-wrap gap-2 text-sm">
      {VERDICTS.map((v) => (
        <li key={v} data-verdict={v} className={`rounded border px-3 py-1 ${VERDICT_CLASS[v]}`}>
          {VERDICT_LABEL[v]}: <span className="font-semibold">{counts[v] ?? 0}</span>
        </li>
      ))}
    </ul>
  );
}
