"use client";

export type Range = { from: string; to: string };
const iso = (d: Date) => d.toISOString().slice(0, 10);

export function presetRange(days: number, now = new Date()): Range {
  const to = new Date(now.getTime() - 86_400_000);
  const from = new Date(to.getTime() - (days - 1) * 86_400_000);
  return { from: iso(from), to: iso(to) };
}

export default function DateRange({ value, onChange }: { value: Range; onChange: (r: Range) => void }) {
  return (
    <div className="flex flex-wrap items-center gap-2 text-sm">
      <button type="button" onClick={() => onChange(presetRange(7))} className="rounded border px-3 py-1">Last 7 days</button>
      <button type="button" onClick={() => onChange(presetRange(30))} className="rounded border px-3 py-1">Last 30 days</button>
      <label className="flex items-center gap-1">From
        <input type="date" value={value.from} max={value.to} onChange={(e) => e.target.value && onChange({ ...value, from: e.target.value })} className="rounded border px-2 py-1" />
      </label>
      <label className="flex items-center gap-1">To
        <input type="date" value={value.to} min={value.from} onChange={(e) => e.target.value && onChange({ ...value, to: e.target.value })} className="rounded border px-2 py-1" />
      </label>
    </div>
  );
}
