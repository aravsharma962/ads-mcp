import { apiContext, getOwnedClient, json, notFound } from "@/lib/api";
import { eventBounds, fetchAllRows, fetchPerformance, hubFailure } from "@/lib/actions/data";
import { analyzePages, suggestRetargeting, type EventRow } from "@/lib/actions/pages";
import { parseActionRules } from "@/lib/actions/rules";
import type { PagesResponse } from "@/lib/actions/types";
import { validateRange } from "@/lib/performance";
import { CONVERSION_EVENTS } from "@/lib/tracking";

type Ctx = { params: Promise<{ clientId: string }> };

export async function GET(request: Request, { params }: Ctx) {
  const a = await apiContext();
  if (a instanceof Response) return a;
  const client = await getOwnedClient(a.db, a.ctx.tenantId, (await params).clientId);
  if (!client) return notFound();
  const sp = new URL(request.url).searchParams;
  const range = validateRange(sp.get("from"), sp.get("to"));
  if (!range) return json({ error: "Enter a valid date range of at most 366 days." }, 400);

  const empty: PagesResponse = { window: range, sessions: 0, bounced_sessions: 0, pages: [], retargeting: [], truncated: false, tracking: false };
  const { data: site } = await a.db.from("sites").select("id, conversion_events").eq("client_id", client.id).maybeSingle();
  if (!site) return json(empty);

  const rules = parseActionRules(client.action_rules);
  const siteConv = (site as { conversion_events?: unknown }).conversion_events;
  const conversionEvents = Array.isArray(siteConv) && siteConv.every((x) => typeof x === "string") && siteConv.length > 0
    ? (siteConv as string[]) : CONVERSION_EVENTS[client.business_type];
  const bounds = eventBounds(range, client.timezone);

  let events: EventRow[];
  let truncated: boolean;
  try {
    const res = await fetchAllRows<Record<string, unknown>>((from, to) =>
      a.db.from("events").select("session_id, name, ad_id, url, value, ts")
        .eq("client_id", client.id).gte("ts", bounds.gte).lte("ts", bounds.lte)
        .order("ts", { ascending: false }).order("id", { ascending: false }).range(from, to));
    events = res.rows.map((r) => ({
      session_id: String(r.session_id), name: String(r.name), ad_id: typeof r.ad_id === "string" ? r.ad_id : null,
      url: typeof r.url === "string" ? r.url : null,
      value: r.value === null || r.value === undefined || !Number.isFinite(Number(r.value)) ? null : Number(r.value),
      ts: String(r.ts),
    }));
    events.reverse(); // fetched newest first so the cap keeps the most recent; analysis expects oldest first
    truncated = res.truncated;
  } catch {
    return json({ error: "Could not load page data right now. Try again in a moment." }, 500);
  }

  const adNames: Record<string, string> = {};
  try {
    const perf = await fetchPerformance(a, client, range, "ad");
    for (const r of perf.rows) {
      const id = r.ad_id ?? r.id;
      if (id && r.name) adNames[id] = r.name;
    }
  } catch (e) {
    return hubFailure(e);
  }

  const stats = analyzePages(events, conversionEvents, rules.bounce_seconds);
  const body: PagesResponse = {
    window: range, sessions: stats.sessions, bounced_sessions: stats.bounced_sessions, pages: stats.pages,
    retargeting: suggestRetargeting(events, conversionEvents, adNames), truncated, tracking: true,
  };
  return json(body);
}
