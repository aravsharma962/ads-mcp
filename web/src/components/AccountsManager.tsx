"use client";

import { useState } from "react";

export default function AccountsManager({ clientId, currency, initial, canEdit }: {
  clientId: string; currency: string; initial: string[]; canEdit: boolean;
}) {
  const [accounts, setAccounts] = useState(initial);
  const [account, setAccount] = useState("");
  const [token, setToken] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function add(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const res = await fetch(`/api/clients/${clientId}/accounts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ account, token }),
    });
    const data = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok) { setError(data.error ?? "Could not connect the account."); return; }
    setAccounts((a) => [...a, data.account.external_id]);
    setAccount("");
    setToken("");
  }

  async function remove(id: string) {
    const res = await fetch(`/api/clients/${clientId}/accounts?external_id=${encodeURIComponent(id)}`, { method: "DELETE" });
    if (res.ok) setAccounts((a) => a.filter((x) => x !== id));
    else setError("Could not remove the account.");
  }

  return (
    <div className="space-y-6">
      <section className="rounded bg-white p-4 shadow">
        <h2 className="mb-2 font-semibold">Connected Meta ad accounts</h2>
        {accounts.length === 0 ? <p className="text-sm text-gray-600">No ad accounts connected.</p> : (
          <ul className="divide-y">
            {accounts.map((id) => (
              <li key={id} className="flex items-center justify-between py-2 text-sm">
                <span>{id}</span>
                {canEdit && <button onClick={() => remove(id)} className="text-red-600 underline">Remove</button>}
              </li>
            ))}
          </ul>
        )}
      </section>
      {canEdit ? (
        <form onSubmit={add} className="space-y-3 rounded bg-white p-4 shadow">
          <h2 className="font-semibold">Connect an ad account</h2>
          <input required placeholder="Ad account id (act_123...)" value={account} onChange={(e) => setAccount(e.target.value)} className="w-full rounded border px-3 py-2" />
          <input required type="password" autoComplete="off" placeholder="Access token (system user, ads_read)" value={token} onChange={(e) => setToken(e.target.value)} className="w-full rounded border px-3 py-2" />
          <p className="text-xs text-gray-500">The token is sent to the data service, stored encrypted, and never shown again. The account must use {currency}.</p>
          {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
          <button disabled={busy} className="rounded bg-black px-4 py-2 text-white disabled:opacity-50">{busy ? "Verifying..." : "Connect account"}</button>
        </form>
      ) : <p className="text-sm text-gray-600">Only the agency owner can connect or remove ad accounts.</p>}
    </div>
  );
}
