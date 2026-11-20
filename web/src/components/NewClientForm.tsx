"use client";

import { useState } from "react";

export default function NewClientForm() {
  const [name, setName] = useState("");
  const [currency, setCurrency] = useState("INR");
  const [timezone, setTimezone] = useState("Asia/Kolkata");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const res = await fetch("/api/clients", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name, currency, timezone }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      setError(data.error ?? "Could not create the client.");
      setBusy(false);
      return;
    }
    window.location.href = `/clients/${data.client.id}/accounts`;
  }

  return (
    <form onSubmit={submit} className="space-y-3 rounded bg-white p-4 shadow">
      <h2 className="font-semibold">New client</h2>
      <div className="flex flex-wrap gap-3">
        <input required placeholder="Client name" value={name} onChange={(e) => setName(e.target.value)} className="rounded border px-3 py-2" />
        <input required maxLength={3} placeholder="Currency (INR)" value={currency} onChange={(e) => setCurrency(e.target.value)} className="w-32 rounded border px-3 py-2" />
        <input required placeholder="Timezone" value={timezone} onChange={(e) => setTimezone(e.target.value)} className="rounded border px-3 py-2" />
        <button disabled={busy} className="rounded bg-black px-4 py-2 text-white disabled:opacity-50">Create client</button>
      </div>
      <p className="text-xs text-gray-500">All ad accounts of one client must use this currency.</p>
      {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
    </form>
  );
}
