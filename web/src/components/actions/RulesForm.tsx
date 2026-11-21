"use client";

import { useState } from "react";
import { DEFAULT_ACTION_RULES, type ActionRules } from "@/lib/actions/types";

type Field = { key: keyof ActionRules; label: string; min: number; max: number; integer?: boolean; help: string };
export const RULE_FIELDS: Field[] = [
  { key: "frequency_max", label: "Max frequency", min: 1, max: 20, help: "Frequency at or above this signals ad fatigue." },
  { key: "ctr_drop_pct", label: "CTR drop (%)", min: 1, max: 90, help: "CTR fell by more than this vs the previous window." },
  { key: "cost_rise_pct", label: "Cost rise (%)", min: 1, max: 500, help: "Cost per result rose by more than this vs the previous window." },
  { key: "min_impressions", label: "Min impressions", min: 100, max: 1_000_000, integer: true, help: "Below this the verdict is \"Too early\"." },
  { key: "min_results_scale", label: "Min results to scale", min: 1, max: 1000, integer: true, help: "Results needed before \"Scale\" can be suggested." },
  { key: "scale_better_pct", label: "Scale when cheaper by (%)", min: 1, max: 90, help: "With no target, scale when cost per result is this much below the account average." },
  { key: "window_days", label: "Window (days)", min: 3, max: 30, integer: true, help: "Length of the recent window; the previous window has the same length." },
  { key: "bounce_seconds", label: "Bounce seconds", min: 1, max: 60, integer: true, help: "A single-page visit shorter than this counts as a bounce." },
];

export function validateRules(values: Record<keyof ActionRules, string>): { rules: ActionRules | null; errors: Partial<Record<keyof ActionRules, string>> } {
  const errors: Partial<Record<keyof ActionRules, string>> = {};
  const out = { ...DEFAULT_ACTION_RULES };
  for (const f of RULE_FIELDS) {
    const raw = values[f.key].trim();
    const n = Number(raw);
    if (raw === "" || !Number.isFinite(n)) errors[f.key] = "Enter a number.";
    else if (f.integer && !Number.isInteger(n)) errors[f.key] = "Enter a whole number.";
    else if (n < f.min || n > f.max) errors[f.key] = `Enter a value from ${f.min} to ${f.max}.`;
    else out[f.key] = n;
  }
  return { rules: Object.keys(errors).length ? null : out, errors };
}

export default function RulesForm({ clientId, initial, onSaved }: { clientId: string; initial: ActionRules; onSaved?: (r: ActionRules) => void }) {
  const [values, setValues] = useState<Record<keyof ActionRules, string>>(() =>
    Object.fromEntries(RULE_FIELDS.map((f) => [f.key, String(initial[f.key])])) as Record<keyof ActionRules, string>);
  const [errors, setErrors] = useState<Partial<Record<keyof ActionRules, string>>>({});
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setMessage(null);
    const { rules, errors } = validateRules(values);
    setErrors(errors);
    if (!rules) return;
    setSaving(true);
    try {
      const res = await fetch(`/api/clients/${clientId}/rules`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(rules) });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error ?? "Could not save the rules.");
      setMessage({ ok: true, text: "Rules saved." });
      onSaved?.(rules);
    } catch (err) {
      setMessage({ ok: false, text: (err as Error).message });
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={onSubmit} noValidate className="space-y-3 rounded border p-3">
      <div className="grid gap-3 md:grid-cols-2">
        {RULE_FIELDS.map((f) => (
          <div key={f.key}>
            <label className="block text-sm">
              {f.label}
              <input type="number" step={f.integer ? 1 : "any"} value={values[f.key]} aria-invalid={!!errors[f.key]}
                onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))} className="mt-1 block w-full rounded border px-2 py-1" />
            </label>
            <p className="text-xs text-gray-500">{f.help}</p>
            {errors[f.key] && <p role="alert" className="text-xs text-red-700">{errors[f.key]}</p>}
          </div>
        ))}
      </div>
      <div className="flex items-center gap-3">
        <button type="submit" disabled={saving} className="rounded bg-black px-3 py-1 text-sm text-white disabled:opacity-50">{saving ? "Saving..." : "Save rules"}</button>
        <button type="button" onClick={() => setValues(Object.fromEntries(RULE_FIELDS.map((f) => [f.key, String(DEFAULT_ACTION_RULES[f.key])])) as Record<keyof ActionRules, string>)} className="rounded border px-3 py-1 text-sm">Reset to defaults</button>
        {message && <span role={message.ok ? "status" : "alert"} className={`text-sm ${message.ok ? "text-green-700" : "text-red-700"}`}>{message.text}</span>}
      </div>
    </form>
  );
}
