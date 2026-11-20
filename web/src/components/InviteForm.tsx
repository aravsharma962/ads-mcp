"use client";

import { useState } from "react";

export default function InviteForm() {
  const [email, setEmail] = useState("");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    const res = await fetch("/api/team/invite", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email }) });
    const data = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok) { setMsg({ ok: false, text: data.error ?? "Could not send the invitation." }); return; }
    setMsg({ ok: true, text: `Invitation sent to ${email}.` });
    setEmail("");
  }

  return (
    <form onSubmit={submit} className="space-y-3 rounded bg-white p-4 shadow">
      <h2 className="font-semibold">Invite a teammate</h2>
      <div className="flex gap-3">
        <input type="email" required placeholder="name@agency.com" value={email} onChange={(e) => setEmail(e.target.value)} className="flex-1 rounded border px-3 py-2" />
        <button disabled={busy} className="rounded bg-black px-4 py-2 text-white disabled:opacity-50">Send invite</button>
      </div>
      <p className="text-xs text-gray-500">Teammates join as members: they can view data, edit targets and use the assistant.</p>
      {msg && <p role="status" className={msg.ok ? "text-green-700" : "text-red-600"}>{msg.text}</p>}
    </form>
  );
}
