import { z } from "zod";
import { apiContext, getOwnedClient, json, notFound, readJson } from "@/lib/api";
import { eventBounds, fetchAllRows, fetchPerformance, hubFailure } from "@/lib/actions/data";
import { leadStats } from "@/lib/actions/leads";
import { LEAD_STATUSES, type LeadRow, type LeadStatus, type LeadsResponse } from "@/lib/actions/types";
import { validateRange } from "@/lib/performance";

type Ctx = { params: Promise<{ clientId: string }> };
const LEAD_EVENTS = ["lead", "form_submit"];

export async function GET(request: Request, { params }: Ctx) {
  const a = await apiContext();
  if (a instanceof Response) return a;
  const client = await getOwnedClient(a.db, a.ctx.tenantId, (await params).clientId);
  if (!client) return notFound();
  const sp = new URL(request.url).searchParams;
  const range = validateRange(sp.get("from"), sp.get("to"));
  if (!range) return json({ error: "Enter a valid date range of at most 366 days." }, 400);

  const base: LeadsResponse = {
    window: range, currency: client.currency, leads: [], total: 0, attributed_total: 0, qualified: 0, won: 0,
    spend: 0, cost_per_lead: null, cost_per_qualified_lead: null, truncated: false, tracking: false, ad_account: false,
  };
  const { data: site } = await a.db.from("sites").select("id").eq("client_id", client.id).maybeSingle();
  if (!site) return json(base);

  const bounds = eventBounds(range, client.timezone);
  let raw: Record<string, unknown>[];
  let truncated: boolean;
  let marks: Map<string, LeadStatus>;
  try {
    const res = await fetchAllRows<Record<string, unknown>>((from, to) =>
      a.db.from("events").select("session_id, ad_id, url, ts")
        .eq("client_id", client.id).in("name", LEAD_EVENTS).gte("ts", bounds.gte).lte("ts", bounds.lte)
        .order("ts", { ascending: false }).order("id", { ascending: false }).range(from, to));
    raw = res.rows;
    truncated = res.truncated;
    const m = await fetchAllRows<{ session_id: string; status: string }>((from, to) =>
      a.db.from("lead_marks").select("session_id, status").eq("client_id", client.id)
        .order("session_id", { ascending: true }).range(from, to));
    marks = new Map(m.rows.filter((r) => (LEAD_STATUSES as readonly string[]).includes(r.status)).map((r) => [r.session_id, r.status as LeadStatus]));
  } catch {
    return json({ error: "Could not load leads right now. Try again in a moment." }, 500);
  }

  let perf;
  try {
    perf = await fetchPerformance(a, client, range, "ad");
  } catch (e) {
    return hubFailure(e);
  }
  const adNames = new Map<string, string>();
  for (const r of perf.rows) {
    const id = r.ad_id ?? r.id;
    if (id && r.name) adNames.set(id, r.name);
  }

  // One row per session: its first lead event. Events arrive newest first (so the cap keeps the most recent), so walk them oldest first.
  raw.reverse();
  const seen = new Set<string>();
  const leads: LeadRow[] = [];
  for (const r of raw) {
    const sid = String(r.session_id);
    if (seen.has(sid)) continue;
    seen.add(sid);
    const adId = typeof r.ad_id === "string" && r.ad_id ? r.ad_id : null;
    leads.push({
      session_id: sid, ts: String(r.ts), ad_id: adId, ad_name: adId ? adNames.get(adId) ?? null : null,
      url: typeof r.url === "string" ? r.url : null, status: marks.get(sid) ?? "new",
    });
  }
  leads.sort((x, y) => (x.ts < y.ts ? 1 : x.ts > y.ts ? -1 : 0));

  const adAccount = perf.accounts > 0;
  const spend = adAccount ? perf.totals.spend : 0;
  const stats = leadStats(leads, spend);
  const body: LeadsResponse = {
    window: range, currency: perf.currency, leads, total: stats.total, attributed_total: stats.attributed_total, qualified: stats.qualified, won: stats.won, spend,
    cost_per_lead: adAccount ? stats.cost_per_lead : null,
    cost_per_qualified_lead: adAccount ? stats.cost_per_qualified_lead : null,
    truncated, tracking: true, ad_account: adAccount,
  };
  return json(body);
}

const Body = z.object({ session_id: z.string().min(1).max(200), status: z.enum(LEAD_STATUSES) }).strict();

export async function PUT(request: Request, { params }: Ctx) {
  const a = await apiContext();
  if (a instanceof Response) return a;
  const client = await getOwnedClient(a.db, a.ctx.tenantId, (await params).clientId);
  if (!client) return notFound();
  const parsed = Body.safeParse(await readJson(request));
  if (!parsed.success) return json({ error: "Send a session_id and a status of new, qualified, won or lost." }, 400);
  const { session_id, status } = parsed.data;

  const { data: hit } = await a.db.from("events").select("session_id")
    .eq("client_id", client.id).eq("session_id", session_id).in("name", LEAD_EVENTS).limit(1);
  if (!Array.isArray(hit) || hit.length === 0) return json({ error: "That lead was not found for this client." }, 404);

  const { error } = await a.db.from("lead_marks")
    .upsert({ client_id: client.id, session_id, status, updated_at: new Date().toISOString() }, { onConflict: "client_id,session_id" });
  if (error) return json({ error: "Could not save the lead status." }, 500);
  return json({ session_id, status });
}
