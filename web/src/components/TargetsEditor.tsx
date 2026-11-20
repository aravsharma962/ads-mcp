"use client";

import { useState } from "react";
import { DIRECTION, EMPTY_BAND, metricDefinition, metricLabel, metricsForType, type BusinessType, type MetricKey, type Targets } from "@/lib/metrics";

type Form = Partial<Record<MetricKey, { min: string; max: string }>>;
const toForm = (t: Targets, keys: MetricKey[]): Form =>
  Object.fromEntries(keys.map((k) => {
    const b = t[k] ?? EMPTY_BAND;
    return [k, { min: b.min === null ? "" : String(b.min), max: b.max === null ? "" : String(b.max) }];
  })) as Form;

export default function TargetsEditor({ clientId, initial, businessType = "ecommerce" }: { clientId: string; initial: Targets; businessType?: BusinessType }) {
  const keys = metricsForType(businessType);
  const [form, setForm] = useState<Form>(toForm(initial, keys));
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  async function send(body: unknown) {
    setMsg(null);
    const res = await fetch(`/api/clients/${clientId}/targets`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { setMsg({ ok: false, text: data.error ?? "Could not save targets." }); return; }
    setForm(toForm(data.targets, keys));
    setMsg({ ok: true, text: "Saved." });
  }

  function save(e: React.FormEvent) {
    e.preventDefault();
    const targets = Object.fromEntries(keys.map((k) => {
      const p = (s: string) => (s.trim() === "" ? null : Number(s));
      const f = form[k] ?? { min: "", max: "" };
      return [k, { min: p(f.min), max: p(f.max) }];
    }));
    for (const b of Object.values(targets)) {
      if ((b.min !== null && !Number.isFinite(b.min)) || (b.max !== null && !Number.isFinite(b.max))) {
        setMsg({ ok: false, text: "Enter numbers only." }); return;
      }
    }
    void send({ targets });
  }

  return (
    <form onSubmit={save} className="space-y-4">
      <table className="w-full rounded bg-white text-sm shadow">
        <thead><tr className="border-b text-left"><th className="p-3">Metric</th><th className="p-3">Better when</th><th className="p-3">Min</th><th className="p-3">Max</th></tr></thead>
        <tbody>
          {keys.map((k) => (
            <tr key={k} className="border-b last:border-0">
              <td className="p-3" title={metricDefinition(businessType, k)}>{metricLabel(businessType, k)}</td>
              <td className="p-3 text-gray-500">{DIRECTION[k]}</td>
              {(["min", "max"] as const).map((f) => (
                <td key={f} className="p-3">
                  <input aria-label={`${metricLabel(businessType, k)} ${f}`} inputMode="decimal" value={form[k]?.[f] ?? ""} onChange={(e) => setForm({ ...form, [k]: { ...(form[k] ?? { min: "", max: "" }), [f]: e.target.value } })} className="w-24 rounded border px-2 py-1" />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      <div className="flex items-center gap-3">
        <button className="rounded bg-black px-4 py-2 text-white">Save</button>
        <button type="button" onClick={() => send({ reset: true })} className="rounded border px-4 py-2">Reset to defaults</button>
        {msg && <span role="status" className={msg.ok ? "text-green-700" : "text-red-600"}>{msg.text}</span>}
      </div>
      <p className="text-xs text-gray-500">Leave a field empty for no limit. The min/max pair is the acceptable band. Metrics without a target show "Set a target" instead of a status.</p>
    </form>
  );
}
