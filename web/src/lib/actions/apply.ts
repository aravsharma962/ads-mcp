import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { ClientRow } from "@/lib/api";
import { callTool } from "@/lib/hub";
import { createServiceClient } from "@/lib/supabase/service";
import { loadActionsData } from "./data";
import { APPLY_ACTIONS, type ActionLogRow, type AdAction, type ApplyAction, type ApplyResponse } from "./types";

type Level = ApplyResponse["level"];
type A = { ctx: { tenantId: string; userId: string }; db: SupabaseClient };
export type ApplyResult = { status: number; body: ApplyResponse | { error: string } };

export const MAX_SCALE_PERCENT = 20;
export const COOLDOWN_DAYS = 3;
export const NOT_ENABLED_MESSAGE = "Changes in Meta are not enabled on this platform yet.";
export const HUB_NOT_ENABLED = "Changes in Meta are not enabled on this platform.";
export const IN_PROGRESS_MESSAGE = "Another change to this ad or budget is in progress. Try again in a minute.";
export const UNKNOWN_MESSAGE = "Meta may or may not have applied this change. Check Ads Manager before trying again.";
export const PENDING_STALE_MS = 2 * 60_000;
const GENERIC_FAILURE = "Meta did not accept the change. Nothing was changed. Try again in a moment.";

export const ApplyBody = z.object({ ad_id: z.string().min(1).max(200), action: z.enum(APPLY_ACTIONS) });

const fail = (status: number, error: string): ApplyResult => ({ status, body: { error } });
const isPermission = (m: string) => /^\s*permission\b/i.test(m);
const isBudgetNotHere = (m: string) => /^\s*budget_not_here\b/i.test(m);
const isUnknown = (m: string) => /^\s*unknown\s*:/i.test(m);
const isUnchanged = (m: string) => /^\s*unchanged\s*:/i.test(m);
/** "prefix: message" -> "message" (hub error codes are not for customers). */
const plain = (m: string) => m.replace(/^\s*(permission|budget_not_here|unchanged)\s*:\s*/i, "").trim();
const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e));
const fmt = (n: unknown) => (typeof n === "number" && Number.isFinite(n) ? n.toLocaleString("en-US") : "?");
export const writesEnabled = () => process.env.META_WRITES_ENABLED === "1";

// Best-effort guard against a double click inside one server instance, keyed by the target object id.
// The pending row (unique index) is the guard across instances.
const inFlight = new Set<string>();

type LogStatus = "ok" | "error" | "unknown";
type LogRow = Pick<ActionLogRow, "action" | "level" | "object_id" | "status" | "created_at">;

/** Latest pause/resume that took effect (or may have) for this ad. */
async function latestPauseState(a: A, clientId: string, adId: string): Promise<LogRow | null> {
  const { data } = await a.db.from("action_log").select("action, level, object_id, status, created_at")
    .eq("client_id", clientId).eq("ad_id", adId).in("action", ["pause", "resume"]).in("status", ["ok", "unknown"])
    .order("created_at", { ascending: false }).limit(1);
  return ((data ?? []) as LogRow[])[0] ?? null;
}

/** Scale cooldown counts ok, unknown, and pending rows younger than the stale limit. */
async function cooldownEnds(a: A, clientId: string, objectIds: string[]): Promise<Date | null> {
  const since = new Date(Date.now() - COOLDOWN_DAYS * 86_400_000).toISOString();
  const { data } = await a.db.from("action_log").select("object_id, created_at, status")
    .eq("client_id", clientId).eq("action", "scale").in("status", ["ok", "unknown", "pending"]).gte("created_at", since).order("created_at", { ascending: false });
  const fresh = Date.now() - PENDING_STALE_MS;
  const hit = ((data ?? []) as { object_id: string; created_at: string; status: string }[])
    .find((r) => objectIds.includes(r.object_id) && (r.status !== "pending" || Date.parse(r.created_at) > fresh));
  return hit ? new Date(Date.parse(hit.created_at) + COOLDOWN_DAYS * 86_400_000) : null;
}

type HubOk = { before: Record<string, unknown>; after: Record<string, unknown>; account: string };
type HubFail = { error: string; status: number; logStatus: "error" | "unknown"; budgetNotHere?: boolean; account?: string };

/**
 * Calls one hub write tool. Rows do not say which ad account an ad belongs to, so the client's accounts are
 * tried in order; an error that is not one of the known categories moves on to the next account.
 */
async function callWrite(tenantId: string, accounts: string[], tool: string, args: Record<string, unknown>): Promise<{ ok: HubOk } | HubFail> {
  let last = GENERIC_FAILURE;
  for (const account of accounts) {
    try {
      const res = await callTool(tenantId, tool, { external_id: account, ...args });
      return { ok: { before: asObj(res?.before), after: asObj(res?.after), account } };
    } catch (e) {
      const m = messageOf(e).trim();
      if (m === HUB_NOT_ENABLED) return { error: NOT_ENABLED_MESSAGE, status: 409, logStatus: "error" };
      if (isUnknown(m)) return { error: UNKNOWN_MESSAGE, status: 409, logStatus: "unknown", account };
      if (isUnchanged(m)) return { error: plain(m) || "Meta does not allow this change right now.", status: 409, logStatus: "error", account };
      if (isPermission(m)) return { error: plain(m) || "The connected Meta token cannot change ads.", status: 409, logStatus: "error" };
      if (isBudgetNotHere(m)) return { error: plain(m), status: 409, logStatus: "error", budgetNotHere: true, account };
      last = GENERIC_FAILURE;
    }
  }
  return { error: last, status: 502, logStatus: "error" };
}
const asObj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

const isUniqueViolation = (e: { code?: string; message?: string } | null) => !!e && (e.code === "23505" || /duplicate key|unique/i.test(e.message ?? ""));

type Svc = ReturnType<typeof createServiceClient>;
type Claim = { id: string } | { result: ApplyResult };

/** Marks stale pending rows unknown, then inserts the pending claim for the object. created_at is the DB default. */
async function claim(svc: Svc, a: A, client: ClientRow, ad: AdAction, action: ApplyAction, level: Level, objectId: string): Promise<Claim> {
  const cutoff = new Date(Date.now() - PENDING_STALE_MS).toISOString();
  await svc.from("action_log").update({ status: "unknown" }).eq("client_id", client.id).eq("status", "pending").lte("created_at", cutoff);
  const { data, error } = await svc.from("action_log").insert({
    tenant_id: a.ctx.tenantId, client_id: client.id, user_id: a.ctx.userId, ad_id: ad.ad_id, ad_name: ad.name,
    action, level, object_id: objectId, status: "pending",
  }).select("id").single();
  if (isUniqueViolation(error)) return { result: fail(409, IN_PROGRESS_MESSAGE) };
  if (error || !data) return { result: fail(502, "Could not record the change, so nothing was changed. Try again in a moment.") };
  return { id: (data as { id: string }).id };
}

async function finish(svc: Svc, client: ClientRow, id: string, outcome: { before?: Record<string, unknown>; after?: Record<string, unknown>; error?: string; status: LogStatus }) {
  const { error } = await svc.from("action_log").update({
    before: outcome.before ?? {}, after: outcome.after ?? {}, status: outcome.status, error: outcome.error ?? null,
  }).eq("id", id).eq("client_id", client.id);
  // The change in Meta is already done (or has failed); a logging problem must not hide that from the caller.
  if (error) console.error("action_log update failed");
}
const release = async (svc: Svc, client: ClientRow, id: string) => { await svc.from("action_log").delete().eq("id", id).eq("client_id", client.id); };
const finishFail = (svc: Svc, client: ClientRow, id: string, r: HubFail) => finish(svc, client, id, { status: r.logStatus, error: r.error });

/** Owner check and body parsing happen in the route. Server recomputes the verdicts; nothing from the browser is trusted. */
export async function applyAction(a: A, client: ClientRow, input: { ad_id: string; action: ApplyAction }): Promise<ApplyResult> {
  if (!writesEnabled()) return fail(409, NOT_ENABLED_MESSAGE);
  const data = await loadActionsData(a, client);
  const ad = data.actions.find((x) => x.ad_id === input.ad_id);
  if (!ad) return fail(404, "That ad was not found in the current data. Refresh the page and try again.");

  const { data: accRows } = await a.db.from("client_accounts").select("external_id").eq("client_id", client.id);
  const accounts = ((accRows ?? []) as { external_id: string }[]).map((r) => r.external_id);
  if (accounts.length === 0) return fail(409, "No ad account is connected to this client.");

  const tenantId = a.ctx.tenantId;
  const label = ad.name || ad.ad_id;
  const svc = createServiceClient();   // service role: only used after the owner check in the route

  const locked: string[] = [];
  const lock = (id: string) => { if (inFlight.has(`${client.id}:${id}`)) return false; inFlight.add(`${client.id}:${id}`); locked.push(id); return true; };
  const unlock = (id: string) => { inFlight.delete(`${client.id}:${id}`); };
  try {
    if (input.action === "pause" || input.action === "resume") {
      const last = await latestPauseState(a, client.id, ad.ad_id);
      let status: "PAUSED" | "ACTIVE";
      if (input.action === "pause") {
        if (ad.verdict !== "pause") return fail(409, "This ad is no longer recommended for pausing. Refresh the list.");
        if (last?.action === "pause") return fail(409, "This ad was already paused from here. Resume it first if you want to change it.");
        status = "PAUSED";
      } else {
        // Pauses are always at ad level on the ad's own id; anything else in the log is not trusted.
        if (last?.action !== "pause" || last.level !== "ad" || last.object_id !== ad.ad_id) return fail(409, "Only ads paused from this platform can be resumed here.");
        status = "ACTIVE";
      }
      if (!lock(ad.ad_id)) return fail(409, IN_PROGRESS_MESSAGE);
      const c = await claim(svc, a, client, ad, input.action, "ad", ad.ad_id);
      if ("result" in c) return c.result;
      const r = await callWrite(tenantId, accounts, "meta_set_status", { object_id: ad.ad_id, level: "ad", status });
      if ("error" in r) {
        await finishFail(svc, client, c.id, r);
        return fail(r.status, r.error);
      }
      await finish(svc, client, c.id, { ...r.ok, status: "ok" });
      const note = input.action === "pause" ? `Ad "${label}" paused in Meta. You can resume it later.` : `Ad "${label}" resumed in Meta.`;
      return { status: 200, body: { ok: true, action: input.action, ad_id: ad.ad_id, level: "ad", object_id: ad.ad_id, before: r.ok.before, after: r.ok.after, note } };
    }

    // scale
    if (ad.verdict !== "scale") return fail(409, "This ad is no longer recommended for scaling. Refresh the list.");
    const targets: { level: Level; id: string }[] = [];
    if (ad.adset_id) targets.push({ level: "adset", id: ad.adset_id });
    if (ad.campaign_id) targets.push({ level: "campaign", id: ad.campaign_id });
    if (targets.length === 0) return fail(409, "This ad has no ad set or campaign to raise the budget on.");
    // Mark stale pending rows unknown first so they count as raises below.
    await svc.from("action_log").update({ status: "unknown" }).eq("client_id", client.id).eq("status", "pending").lte("created_at", new Date(Date.now() - PENDING_STALE_MS).toISOString());
    const until = await cooldownEnds(a, client.id, targets.map((t) => t.id));
    if (until) return fail(409, `The budget was already raised in the last ${COOLDOWN_DAYS} days. Wait until ${until.toISOString().slice(0, 10)} before raising it again.`);

    const percent = MAX_SCALE_PERCENT;
    let accts = accounts;
    let lastErr: HubFail | null = null;
    for (let i = 0; i < targets.length; i++) {
      const t = targets[i];
      if (!lock(t.id)) return fail(409, IN_PROGRESS_MESSAGE);
      const c = await claim(svc, a, client, ad, "scale", t.level, t.id);
      if ("result" in c) return c.result;
      const r = await callWrite(tenantId, accts, "meta_raise_budget", { object_id: t.id, level: t.level, percent });
      if ("ok" in r) {
        await finish(svc, client, c.id, { ...r.ok, status: "ok" });
        const noun = t.level === "adset" ? "Ad set" : "Campaign";
        return { status: 200, body: { ok: true, action: "scale", ad_id: ad.ad_id, level: t.level, object_id: t.id, before: r.ok.before, after: r.ok.after,
          note: `${noun} budget raised from ${fmt(r.ok.before.daily_budget)} to ${fmt(r.ok.after.daily_budget)} (+${percent}%).` } };
      }
      lastErr = r;
      if (r.budgetNotHere && i < targets.length - 1) {
        await release(svc, client, c.id);    // nothing was attempted on this object; the campaign try is the one that gets logged
        unlock(t.id);
        if (r.account) accts = [r.account];  // the hub accepted this account
        continue;
      }
      await finishFail(svc, client, c.id, r);
      return fail(r.status, r.error);
    }
    return fail(lastErr?.status ?? 502, lastErr?.error ?? GENERIC_FAILURE);
  } finally {
    for (const id of locked) unlock(id);
  }
}

/** Last 50 attempts for the client, newest first. `writes_enabled` is the server switch META_WRITES_ENABLED. */
export async function loadApplyLog(db: SupabaseClient, clientId: string): Promise<{ log: ActionLogRow[]; writes_enabled: boolean }> {
  const { data } = await db.from("action_log")
    .select("id, created_at, user_id, ad_id, ad_name, action, level, object_id, before, after, status, error")
    .eq("client_id", clientId).order("created_at", { ascending: false }).limit(50);
  const log = ((data ?? []) as ActionLogRow[]).map((r) => ({
    id: r.id, created_at: r.created_at, user_id: r.user_id, ad_id: r.ad_id, ad_name: r.ad_name, action: r.action, level: r.level,
    object_id: r.object_id, before: r.before, after: r.after, status: r.status, error: r.error,
  }));
  return { log, writes_enabled: writesEnabled() };
}
