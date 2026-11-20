"use client";

import { useState } from "react";
import { BUSINESS_TYPE_LABELS, type BusinessType } from "@/lib/metrics";

type Site = { site_key: string; allowed_origins: string[] };
type Health = { eventsLast24h: number; sessionsMissingAdIds: number; lastEventAt: string | null };

export const URL_PARAMS = "utm_source=facebook&utm_campaign={{campaign.id}}&utm_term={{adset.id}}&utm_content={{ad.id}}";

/** Events the agency should send from the client's website, per business type. */
export const EVENT_EXAMPLES: Record<BusinessType, { code: string; note: string }[]> = {
  ecommerce: [
    { code: "adsTrack('add_to_cart')", note: "when a visitor adds a product to the cart" },
    { code: "adsTrack('purchase', {value: 499, currency: 'INR'})", note: "after a completed order" },
  ],
  lead_gen: [
    { code: "adsTrack('lead')", note: "when an enquiry, booking or call-back request is completed" },
  ],
  saas_b2b: [
    { code: "adsTrack('signup')", note: "when a visitor creates an account" },
    { code: "adsTrack('trial_start')", note: "when a trial begins" },
    { code: "adsTrack('demo_booked')", note: "when a demo is booked" },
    { code: "adsTrack('paid', {value: 99, currency: 'USD'})", note: "on each successful payment (CAC counts these events)" },
  ],
};

export default function TrackingSetup({ clientId, appUrl, initialSite, initialHealth, canEdit, businessType = "ecommerce" }: {
  clientId: string; appUrl: string; initialSite: Site | null; initialHealth: Health | null; canEdit: boolean; businessType?: BusinessType;
}) {
  const [site, setSite] = useState(initialSite);
  const [health] = useState(initialHealth);
  const [origins, setOrigins] = useState((initialSite?.allowed_origins ?? []).join("\n"));
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const url = `/api/clients/${clientId}/site`;

  async function send(method: "POST" | "PUT", body: unknown) {
    setBusy(true);
    setError(null);
    setSaved(false);
    const res = await fetch(url, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const data = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok) { setError(data.error ?? "Could not save."); return; }
    setSite(data.site);
    setOrigins((data.site.allowed_origins as string[]).join("\n"));
    setSaved(true);
  }
  const list = () => origins.split(/[\s,]+/).filter(Boolean);

  const originsForm = (
    <div className="space-y-2">
      <label className="block text-sm font-medium" htmlFor="origins">Website addresses allowed to send events (one per line)</label>
      <textarea id="origins" rows={3} value={origins} onChange={(e) => setOrigins(e.target.value)} placeholder="https://www.yourclient.com" className="w-full rounded border px-3 py-2 text-sm" />
    </div>
  );

  if (!site) {
    return canEdit ? (
      <form onSubmit={(e) => { e.preventDefault(); void send("POST", { allowed_origins: list() }); }} className="space-y-3 rounded bg-white p-4 shadow">
        <h2 className="font-semibold">Set up website tracking</h2>
        <p className="text-sm text-gray-600">Track what happens after someone clicks the ad: visits, add to cart and form submissions.</p>
        {originsForm}
        {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
        <button disabled={busy} className="rounded bg-black px-4 py-2 text-white disabled:opacity-50">Create tracking site</button>
      </form>
    ) : <p className="text-sm text-gray-600">Only the agency owner can set up tracking.</p>;
  }

  const snippet = `<script async src="${appUrl.replace(/\/+$/, "")}/t.js" data-site-key="${site.site_key}"></script>`;
  return (
    <div className="space-y-6">
      <section className="space-y-2 rounded bg-white p-4 shadow">
        <h2 className="font-semibold">1. Add this snippet to every page of the website</h2>
        <pre data-testid="snippet" className="overflow-x-auto rounded bg-gray-100 p-3 text-xs">{snippet}</pre>
        <p className="text-xs text-gray-500">Form submissions are detected automatically as form_submit events (they also count as leads for lead generation clients). Other events are listed in step 3. To wait for cookie consent, add <code>data-consent=&quot;manual&quot;</code> and call <code>adsTrack.consent()</code> after the visitor agrees.</p>
      </section>
      <section className="space-y-2 rounded bg-white p-4 shadow">
        <h2 className="font-semibold">2. Add these URL parameters to every ad</h2>
        <pre data-testid="url-params" className="overflow-x-auto rounded bg-gray-100 p-3 text-xs">{URL_PARAMS}</pre>
        <p className="text-xs text-gray-500">Paste into the ad&apos;s URL parameters field. Meta fills in the ids. Ads without them show up as &quot;unattributed&quot;.</p>
      </section>
      <section className="space-y-2 rounded bg-white p-4 shadow">
        <h2 className="font-semibold">3. Send these events from the website ({BUSINESS_TYPE_LABELS[businessType]})</h2>
        <ul data-testid="events" className="space-y-1 text-sm">
          {EVENT_EXAMPLES[businessType].map((e) => (
            <li key={e.code}><code className="rounded bg-gray-100 px-1 text-xs">{e.code}</code> {e.note}</li>
          ))}
        </ul>
        <p className="text-xs text-gray-500">Call these from the page or button that confirms the action. Never send names, emails or phone numbers: the collector rejects them. The business type is set on the Targets page.</p>
      </section>
      <section className="space-y-2 rounded bg-white p-4 shadow">
        <h2 className="font-semibold">Tracking health</h2>
        {health && (
          <dl className="grid grid-cols-3 gap-4 text-sm">
            <div><dt className="text-gray-500">Events in the last 24 hours</dt><dd data-testid="health-events" className="text-xl font-semibold">{health.eventsLast24h}</dd></div>
            <div><dt className="text-gray-500">Sessions without ad ids (24h)</dt><dd data-testid="health-missing" className="text-xl font-semibold">{health.sessionsMissingAdIds}</dd></div>
            <div><dt className="text-gray-500">Last event</dt><dd className="text-sm">{health.lastEventAt ? new Date(health.lastEventAt).toLocaleString("en-GB") : "none yet"}</dd></div>
          </dl>
        )}
        <p className="text-xs text-gray-500">Tracked numbers will differ from Meta Ads Manager: ad blockers, missing URL parameters and visitor consent choices all affect what is seen. Rates are measured against ad link clicks, so bot clicks can distort them.</p>
      </section>
      {canEdit && (
        <section className="space-y-3 rounded bg-white p-4 shadow">
          <h2 className="font-semibold">Settings</h2>
          {originsForm}
          {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
          {saved && <p role="status" className="text-sm text-green-700">Saved.</p>}
          <div className="flex gap-3">
            <button disabled={busy} onClick={() => void send("PUT", { allowed_origins: list() })} className="rounded bg-black px-4 py-2 text-white disabled:opacity-50">Save addresses</button>
            <button disabled={busy} onClick={() => { if (confirm("Rotate the site key? The snippet on the website must be updated, or tracking stops.")) void send("PUT", { rotate_key: true }); }} className="rounded border px-4 py-2 disabled:opacity-50">Rotate site key</button>
          </div>
        </section>
      )}
    </div>
  );
}
