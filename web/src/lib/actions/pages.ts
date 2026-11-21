/** Page analysis (exits, bounces) and retargeting ideas from first-party tracker events. Pure functions. */
import type { PageStat, RetargetSuggestion } from "./types";

export type EventRow = { session_id: string; name: string; ad_id: string | null; url: string | null; value: number | null; ts: string };

const MIN_RETARGET_VISITORS = 5;

/** A tracker "session_id" is really a 30 day visitor id, so each visitor's events are split into visits. */
const VISIT_GAP_MS = 30 * 60 * 1000;

type Visit = { visitor: string; views: EventRow[]; leave: number | null; converted: boolean };

function visitsOf(events: EventRow[], conversionEvents: string[]): Visit[] {
  const conv = new Set(conversionEvents);
  const sorted = events.map((e, i) => ({ e, i })).sort((a, b) => (a.e.ts < b.e.ts ? -1 : a.e.ts > b.e.ts ? 1 : a.i - b.i));
  const current = new Map<string, { visit: Visit; lastMs: number }>();
  const visits: Visit[] = [];
  for (const { e } of sorted) {
    const ms = Date.parse(e.ts);
    let c = current.get(e.session_id);
    if (!c || (Number.isFinite(ms) && Number.isFinite(c.lastMs) && ms - c.lastMs > VISIT_GAP_MS)) {
      c = { visit: { visitor: e.session_id, views: [], leave: null, converted: false }, lastMs: ms };
      current.set(e.session_id, c);
      visits.push(c.visit);
    }
    c.lastMs = ms;
    const s = c.visit;
    if (conv.has(e.name)) s.converted = true;
    else if (e.name === "page_view" && e.url) s.views.push(e);
    else if (e.name === "page_leave" && typeof e.value === "number" && Number.isFinite(e.value) && e.value >= 0) s.leave = e.value;
  }
  return visits;
}

export function analyzePages(events: EventRow[], conversionEvents: string[], bounceSeconds: number): { pages: PageStat[]; sessions: number; bounced_sessions: number } {
  const pages = new Map<string, PageStat>();
  let sessions = 0;
  let bounced = 0;
  let anyLeave = false;
  for (const s of visitsOf(events, conversionEvents)) {
    if (s.views.length === 0) continue;
    if (s.leave !== null) anyLeave = true;
    sessions++;
    const urls = new Set(s.views.map((v) => v.url as string));
    const lastUrl = s.views[s.views.length - 1].url as string;
    const bounce = !s.converted && urls.size === 1 && s.leave !== null && s.leave < bounceSeconds;
    if (bounce) bounced++;
    for (const url of urls) {
      let p = pages.get(url);
      if (!p) pages.set(url, (p = { url, sessions: 0, exits: 0, exit_rate: null, bounces: 0, bounce_rate: null, conversions: 0 }));
      p.sessions++;
      if (s.converted) p.conversions++;
      else if (url === lastUrl) p.exits++;
      if (bounce) p.bounces++;
    }
  }
  const list = [...pages.values()].map((p) => ({
    ...p,
    exit_rate: p.sessions > 0 ? p.exits / p.sessions : null,
    bounce_rate: anyLeave && p.sessions > 0 ? p.bounces / p.sessions : null,   // null = no page_leave data at all
  }));
  list.sort((a, b) => b.sessions - a.sessions || a.url.localeCompare(b.url));
  return { pages: list, sessions, bounced_sessions: bounced };
}

function advice(url: string): string {
  const u = url.toLowerCase();
  if (/pric|cost|plans?\b/.test(u)) return "a creative that answers price questions (offer, comparison, proof)";
  if (/trial/.test(u)) return "a creative that lowers the risk of starting a trial (free, no card, quick setup)";
  if (/size|sizing/.test(u)) return "a creative that answers size and fit questions (size guide, easy returns)";
  if (/demo/.test(u)) return "a creative that shows what the demo covers and how short it is (preview, testimonial)";
  return "a creative that shows the product again with proof (reviews, results, a clear offer)";
}

export function suggestRetargeting(events: EventRow[], conversionEvents: string[], adNames: Record<string, string>, limit = 5): RetargetSuggestion[] {
  const groups = new Map<string, { url: string; ad_id: string | null; sessions: Set<string> }>();   // sessions = distinct visitors
  for (const s of visitsOf(events, conversionEvents)) {
    const sid = s.visitor;
    if (s.converted) continue;
    const seen = new Set<string>();
    for (const v of s.views) {
      const url = v.url as string;
      const key = `${url}\u0000${v.ad_id ?? ""}`;
      if (seen.has(key)) continue;
      seen.add(key);
      let g = groups.get(key);
      if (!g) groups.set(key, (g = { url, ad_id: v.ad_id, sessions: new Set() }));
      g.sessions.add(sid);
    }
  }
  return [...groups.values()]
    .filter((g) => g.sessions.size >= MIN_RETARGET_VISITORS)
    .sort((a, b) => b.sessions.size - a.sessions.size || a.url.localeCompare(b.url))
    .slice(0, Math.max(0, limit))
    .map((g) => {
      const ad_name = g.ad_id ? adNames[g.ad_id] ?? null : null;
      const n = g.sessions.size;
      const from = g.ad_id ? ` from ad ${ad_name ? `"${ad_name}"` : g.ad_id}` : "";
      return {
        url: g.url, ad_id: g.ad_id, ad_name, visitors: n,
        text: `${n} visitors${from} viewed ${g.url} and left without converting. Retarget them with ${advice(g.url)}.`,
      };
    });
}
