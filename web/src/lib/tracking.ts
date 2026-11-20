import { randomBytes } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";

export type TrackingHealth = { eventsLast24h: number; sessionsMissingAdIds: number; lastEventAt: string | null };

export const newSiteKey = () => "sk_" + randomBytes(18).toString("base64url");

/** Returns normalized origins, or null when any entry is not an http(s) origin. */
export function normalizeOrigins(input: unknown): string[] | null {
  if (!Array.isArray(input) || input.length > 20) return null;
  const out: string[] = [];
  for (const v of input) {
    if (typeof v !== "string") return null;
    let u: URL;
    try {
      u = new URL(v.trim());
    } catch {
      return null;
    }
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    if (!out.includes(u.origin)) out.push(u.origin);
  }
  return out;
}

/** Health of one client's tracking. Always filtered by the given client id. */
export async function trackingHealth(db: SupabaseClient, clientId: string, now: Date = new Date()): Promise<TrackingHealth> {
  const since = new Date(now.getTime() - 24 * 3600_000).toISOString();
  const { data } = await db.from("events").select("session_id, ad_id, ts").eq("client_id", clientId).gte("ts", since).limit(10_000);
  const rows = (data ?? []) as { session_id: string; ad_id: string | null }[];
  const withAd = new Set<string>();
  const all = new Set<string>();
  for (const r of rows) {
    all.add(r.session_id);
    if (r.ad_id) withAd.add(r.session_id);
  }
  const { data: last } = await db.from("events").select("ts").eq("client_id", clientId).order("ts", { ascending: false }).limit(1);
  const lastEventAt = ((last ?? []) as { ts: string }[])[0]?.ts ?? null;
  return { eventsLast24h: rows.length, sessionsMissingAdIds: all.size - withAd.size, lastEventAt };
}
