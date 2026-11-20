import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import { createServiceClient } from "@/lib/supabase/service";
import { createLimiter } from "@/lib/ratelimit";

export const dynamic = "force-dynamic";

const MAX_BODY = 4096;
const EVENTS = ["page_view", "add_to_cart", "form_submit", "purchase", "signup", "trial_start", "demo_booked", "lead", "paid"] as const;
const PERSONAL = /^(e-?mail|phone|mobile|tel|name|first_?name|last_?name|full_?name)$/i;
const limiter = createLimiter({ limit: 60, windowMs: 60_000 });
const siteBudget = createLimiter({ limit: 1200, windowMs: 60_000 });          // all events of one site key
const ipLimiter = createLimiter({ limit: 120, windowMs: 60_000 });             // one visitor address per site
const MAX_PURCHASE_VALUE = 10_000_000;            // applies to purchase and paid
// The salt lives only in this process's memory and the limiter keys are hashes: raw IPs are never kept or stored.
const IP_SALT = randomBytes(16);
function ipKey(request: Request, siteKey: string): string | null {
  const ip = (request.headers.get("x-forwarded-for") ?? "").split(",")[0].trim() || request.headers.get("x-real-ip")?.trim() || "";
  if (!ip) return null;
  return `${siteKey}:${createHash("sha256").update(IP_SALT).update(ip).digest("hex")}`;
}

/** Reads at most MAX_BODY bytes; stops pulling the stream as soon as the cap is passed. */
async function readCapped(request: Request): Promise<string | null> {
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BODY) {
      try { await reader.cancel(); } catch { /* ignore */ }
      return null;
    }
    chunks.push(value);
  }
  const buf = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { buf.set(c, off); off += c.byteLength; }
  return new TextDecoder().decode(buf);
}
const BOT = /bot|crawl|spider|slurp|headless|lighthouse|preview|curl|wget|python-requests/i;

const id = z.string().regex(/^\d{1,25}$/).nullable();
const Body = z.object({
  site_key: z.string().min(1).max(100),
  session_id: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/),
  event: z.enum(EVENTS),
  campaign_id: id,
  adset_id: id,
  ad_id: id,
  url: z.string().max(2000).nullable(),
  value: z.number().finite().min(0).max(1e9).nullable(),
  currency: z.string().regex(/^[A-Z]{3}$/).nullable(),
}).strict();

const empty = (status: number, headers: Record<string, string> = {}) => new Response(null, { status, headers });
const text = (status: number, error: string) => Response.json({ error }, { status });

function cors(origin: string): Record<string, string> {
  return { "access-control-allow-origin": origin, vary: "Origin" };
}

async function findSite(siteKey: string) {
  const { data } = await createServiceClient()
    .from("sites").select("client_id, allowed_origins").eq("site_key", siteKey).maybeSingle();
  return (data as { client_id: string; allowed_origins: string[] } | null) ?? null;
}
const allowed = (site: { allowed_origins: string[] }, origin: string | null) =>
  !!origin && (site.allowed_origins ?? []).some((o) => o.toLowerCase() === origin.toLowerCase());

/** The tracker puts the (public) site key in the URL so the preflight can be answered per site. */
export async function OPTIONS(request: Request) {
  const origin = request.headers.get("origin");
  const key = new URL(request.url).searchParams.get("k");
  if (!key) return empty(403);
  const site = await findSite(key);
  if (!site) return empty(404);
  if (!allowed(site, origin)) return empty(403);
  return empty(204, { ...cors(origin!), "access-control-allow-methods": "POST, OPTIONS", "access-control-allow-headers": "content-type", "access-control-max-age": "600" });
}

export async function POST(request: Request) {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_BODY) return text(413, "Request too large.");
  const raw = await readCapped(request);
  if (raw === null) return text(413, "Request too large.");

  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return text(400, "Invalid JSON.");
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) return text(400, "Invalid body.");
  const obj = data as Record<string, unknown>;
  if (Object.keys(obj).some((k) => PERSONAL.test(k))) return text(400, "Personal data fields are not accepted.");

  const siteKey = typeof obj.site_key === "string" ? obj.site_key.slice(0, 100) : "";
  const site = siteKey ? await findSite(siteKey) : null;
  if (!site) return text(404, "Unknown site.");
  const origin = request.headers.get("origin");
  if (!allowed(site, origin)) return text(403, "Origin not allowed.");

  const parsed = Body.safeParse(obj);
  if (!parsed.success) return text(400, "Invalid event.");
  const e = parsed.data;

  if ((e.event === "purchase" || e.event === "paid") && e.value !== null && e.value > MAX_PURCHASE_VALUE) return text(400, "Implausible purchase value.");
  const ipk = ipKey(request, siteKey);
  if (ipk && !ipLimiter.hit(ipk)) return text(429, "Too many events.");
  if (!siteBudget.hit(siteKey)) return text(429, "Too many events.");
  if (!limiter.hit(`${siteKey}:${e.session_id}`)) return text(429, "Too many events.");
  if (BOT.test(request.headers.get("user-agent") ?? "")) return empty(204, cors(origin!));

  let url: string | null = null;
  if (e.url) {
    try {
      const u = new URL(e.url);
      if (u.protocol === "http:" || u.protocol === "https:") url = u.origin + u.pathname;
    } catch { /* drop an unparseable url */ }
  }
  const { error } = await createServiceClient().from("events").insert({
    client_id: site.client_id, session_id: e.session_id, name: e.event,
    campaign_id: e.campaign_id, adset_id: e.adset_id, ad_id: e.ad_id,
    url, value: e.value, currency: e.currency, ts: new Date().toISOString(),
  });
  if (error) return text(500, "Could not record the event.");
  return empty(204, cors(origin!));
}
