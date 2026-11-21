import type { SupabaseClient } from "@supabase/supabase-js";
import { json, type ClientRow } from "@/lib/api";
import { HubError, callTool } from "@/lib/hub";
import { normalizeRow, normalizeUnattributed, sumRows, type Level, type PerfRow, type PerfTotals } from "@/lib/performance";
import { loadTargets } from "@/lib/targets";
import type { Targets } from "@/lib/metrics";
import { parseActionRules } from "./rules";
import { computeActions } from "./verdicts";
import type { ActionRules, AdAction } from "./types";

type A = { ctx: { tenantId: string }; db: SupabaseClient };
type Window = { from: string; to: string };

export type Performance = {
  currency: string; tracking: boolean; accounts: number; business_type: ClientRow["business_type"];
  rows: PerfRow[]; totals: PerfTotals; unattributed: ReturnType<typeof normalizeUnattributed> | null;
};

/** Loads and normalizes performance for one client. Throws on hub failure (see hubFailure). */
export async function fetchPerformance(a: A, client: ClientRow, range: Window, level: Level): Promise<Performance> {
  const { data: accRows } = await a.db.from("client_accounts").select("external_id").eq("client_id", client.id);
  const accounts = ((accRows ?? []) as { external_id: string }[]).map((r) => r.external_id);
  const { data: site } = await a.db.from("sites").select("id").eq("client_id", client.id).maybeSingle();
  const tracking = !!site;
  const type = client.business_type;
  const src = { tracking, roasSource: client.roas_source, type };

  let currency = client.currency;
  const rawRows: unknown[] = [];
  let unattributed = null;
  if (accounts.length > 0) {
    if (tracking) {
      const res = await callTool(a.ctx.tenantId, "ads_performance", {
        client_id: client.id, date_from: range.from, date_to: range.to, level,
      });
      if (Array.isArray(res?.rows)) rawRows.push(...res.rows);
      unattributed = normalizeUnattributed(res?.unattributed);
      if (typeof res?.currency === "string") currency = res.currency;
    } else {
      for (const externalId of accounts) {
        const res = await callTool(a.ctx.tenantId, "meta_ads_insights", {
          external_id: externalId, date_from: range.from, date_to: range.to, level,
        });
        if (Array.isArray(res?.rows)) rawRows.push(...res.rows);
        if (typeof res?.currency === "string") currency = res.currency;
      }
    }
  }
  const rows = rawRows.map((r) => normalizeRow(r, src));
  return { currency, tracking, accounts: accounts.length, business_type: type, rows, totals: sumRows(rows, src), unattributed };
}

/** 429 stays 429; any other failure is a plain 502. Nothing internal is returned. */
export function hubFailure(e: unknown): Response {
  const status = e instanceof HubError && e.status === 429 ? 429 : 502;
  return json({ error: "Could not load performance data right now. Try again in a moment." }, status);
}

const addDays = (iso: string, n: number) => new Date(Date.parse(iso + "T00:00:00Z") + n * 86_400_000).toISOString().slice(0, 10);

/** Two windows of equal length: recent ends yesterday, previous ends the day before recent starts. */
export function computeWindows(windowDays: number, todayIso: string): { recent: Window; previous: Window } {
  const n = Math.max(1, Math.round(windowDays));
  const recent = { from: addDays(todayIso, -n), to: addDays(todayIso, -1) };
  const previous = { from: addDays(recent.from, -n), to: addDays(recent.from, -1) };
  return { recent, previous };
}

/** Today's date in the client's time zone (UTC when the zone is unknown). */
export function todayIn(timezone: string | null | undefined, now = new Date()): string {
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone: timezone || "UTC", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
  } catch {
    return now.toISOString().slice(0, 10);
  }
}

export type ActionsData = {
  rules: ActionRules; windows: { recent: Window; previous: Window }; targets: Targets; currency: string;
  recent: Performance; previous: Performance; actions: AdAction[]; adAccount: boolean;
};

/** Shared by the actions and report routes. Throws on hub failure. */
export async function loadActionsData(a: A & { db: SupabaseClient }, client: ClientRow): Promise<ActionsData> {
  const rules = parseActionRules(client.action_rules);
  const windows = computeWindows(rules.window_days, todayIn(client.timezone));
  const targets = await loadTargets(a.db, client.id, client.business_type);
  const [recent, previous] = await Promise.all([
    fetchPerformance(a, client, windows.recent, "ad"),
    fetchPerformance(a, client, windows.previous, "ad"),
  ]);
  const currency = recent.currency || client.currency;
  const actions = computeActions({ type: client.business_type, recent: recent.rows, previous: previous.rows, rules, targets, currency });
  return { rules, windows, targets, currency, recent, previous, actions, adAccount: recent.accounts > 0 };
}

export const MAX_EVENT_ROWS = 20_000;
const PAGE = 1000;

/** Pages through a query (ordered, stable) up to MAX_EVENT_ROWS. `truncated` is true only when more rows exist. */
export async function fetchAllRows<T>(page: (from: number, to: number) => PromiseLike<{ data: unknown; error: unknown }>): Promise<{ rows: T[]; truncated: boolean }> {
  const rows: T[] = [];
  while (rows.length < MAX_EVENT_ROWS) {
    const { data, error } = await page(rows.length, rows.length + PAGE - 1);
    if (error) throw new Error("query failed");
    const got = (Array.isArray(data) ? data : []) as T[];
    rows.push(...got);
    if (got.length < PAGE) return { rows, truncated: false };
  }
  const { data, error } = await page(rows.length, rows.length);
  if (error) throw new Error("query failed");
  return { rows, truncated: Array.isArray(data) && data.length > 0 };
}

/** UTC instant of local midnight at the start of `iso` (YYYY-MM-DD) in `timezone`; null when the zone is invalid. */
function zonedMidnight(iso: string, timezone: string): number | null {
  try {
    const fmt = new Intl.DateTimeFormat("en-US", { timeZone: timezone, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric" });
    const offsetAt = (t: number) => {
      const p = Object.fromEntries(fmt.formatToParts(new Date(t)).map((x) => [x.type, Number(x.value)]));
      return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(t / 1000) * 1000;
    };
    const local = Date.parse(iso + "T00:00:00Z");
    let t = local - offsetAt(local);
    t = local - offsetAt(t); // second pass settles DST edges
    return t;
  } catch {
    return null;
  }
}

/**
 * Event timestamps cover the same calendar days as the spend window, inclusive of the whole last day,
 * in the client's timezone (UTC when the zone is missing or unknown).
 */
export const eventBounds = (range: Window, timezone?: string | null) => {
  const start = timezone ? zonedMidnight(range.from, timezone) : null;
  const end = timezone ? zonedMidnight(addDays(range.to, 1), timezone) : null;
  if (start === null || end === null) return { gte: `${range.from}T00:00:00.000Z`, lte: `${range.to}T23:59:59.999Z` };
  return { gte: new Date(start).toISOString(), lte: new Date(end - 1).toISOString() };
};
