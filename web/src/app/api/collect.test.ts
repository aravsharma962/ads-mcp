import { describe, it, expect, vi, beforeEach } from "vitest";
import { FakeDb } from "@/test/fakeDb";
import { CA, CB } from "@/test/harness";

const state = vi.hoisted(() => ({ db: null as any }));
vi.mock("@/lib/supabase/service", () => ({ createServiceClient: () => state.db }));

import { POST, OPTIONS } from "./collect/route";

const ORIGIN = "https://shop.example";
let db: FakeDb;
let n = 0;

beforeEach(() => {
  db = new FakeDb({
    sites: [
      { id: "s1", client_id: CA, site_key: "sk_A", allowed_origins: [ORIGIN, "https://www.shop.example"] },
      { id: "s3", client_id: CA, site_key: "sk_BUDGET", allowed_origins: [ORIGIN] },
      { id: "s4", client_id: CA, site_key: "sk_IP", allowed_origins: [ORIGIN] },
      { id: "s2", client_id: CB, site_key: "sk_B", allowed_origins: ["https://other.example"] },
    ],
  });
  state.db = db;
});

const sid = () => (++n).toString(16).padStart(32, "0");
const body = (o: Record<string, unknown> = {}) => ({ site_key: "sk_A", session_id: sid(), event: "page_view", campaign_id: "1", adset_id: "2", ad_id: "3", url: "https://shop.example/p?email=a@b.c#x", value: null, currency: null, ...o });
function post(b: unknown, headers: Record<string, string> = { origin: ORIGIN }, raw?: string) {
  return POST(new Request("http://localhost/api/collect?k=sk_A", { method: "POST", headers: { "content-type": "text/plain;charset=UTF-8", ...headers }, body: raw ?? JSON.stringify(b) }));
}

describe("POST /api/collect", () => {
  it("stores a valid event for the site's client with 204 and CORS for the allowed origin", async () => {
    const res = await post(body({ event: "purchase", value: 499, currency: "INR" }));
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe(ORIGIN);
    expect(res.headers.get("vary")).toMatch(/origin/i);
    const [row] = db.rows("events");
    expect(row).toMatchObject({ client_id: CA, name: "purchase", campaign_id: "1", adset_id: "2", ad_id: "3", value: 499, currency: "INR" });
    expect(row.url).toBe("https://shop.example/p");           // query string and fragment are dropped
    expect(typeof row.ts).toBe("string");
  });

  it("never persists an ip or any request header data", async () => {
    await post(body(), { origin: ORIGIN, "x-forwarded-for": "203.0.113.9", "user-agent": "Mozilla/5.0" });
    expect(JSON.stringify(db.rows("events"))).not.toMatch(/203\.0\.113|Mozilla|ip/i);
    expect(Object.keys(db.rows("events")[0]).sort()).toEqual(["ad_id", "adset_id", "campaign_id", "client_id", "currency", "id", "name", "session_id", "ts", "url", "value"]);
  });

  it("unknown site key -> 404 and nothing stored", async () => {
    expect((await post(body({ site_key: "nope" }))).status).toBe(404);
    expect(db.rows("events")).toHaveLength(0);
  });

  it("origin not allowed (or missing) -> 403 and nothing stored; another site's origin does not work", async () => {
    expect((await post(body(), { origin: "https://evil.example" })).status).toBe(403);
    expect((await post(body(), { origin: "https://other.example" })).status).toBe(403);
    expect((await post(body(), {})).status).toBe(403);
    expect(db.rows("events")).toHaveLength(0);
  });

  it.each(["email", "phone", "name", "Email", "full_name"])("personal-data field %s -> 400 and nothing stored", async (k) => {
    expect((await post(body({ [k]: "x" }))).status).toBe(400);
    expect(db.rows("events")).toHaveLength(0);
  });

  it("body over 4 KB -> 413 (by header and by content)", async () => {
    expect((await post(body({ url: "https://shop.example/" + "a".repeat(5000) }))).status).toBe(413);
    const big = new Request("http://localhost/api/collect", { method: "POST", headers: { origin: ORIGIN, "content-length": "99999" }, body: "{}" });
    expect((await POST(big)).status).toBe(413);
    expect(db.rows("events")).toHaveLength(0);
  });

  it("unknown event name, malformed json, bad ids -> 400", async () => {
    expect((await post(body({ event: "hack" }))).status).toBe(400);
    expect((await post(null, { origin: ORIGIN }, "not json")).status).toBe(400);
    expect((await post(body({ ad_id: "12abc" }))).status).toBe(400);
    expect((await post(body({ currency: "rupees" }))).status).toBe(400);
    expect((await post(body({ value: -5 }))).status).toBe(400);
    expect((await post(body({ extra: 1 }))).status).toBe(400);
    expect(db.rows("events")).toHaveLength(0);
  });

  it("rate limits to 60 events per minute per site key + session", async () => {
    const session = sid();
    const codes: number[] = [];
    for (let i = 0; i < 62; i++) codes.push((await post(body({ session_id: session }))).status);
    expect(codes.filter((c) => c === 204)).toHaveLength(60);
    expect(codes.slice(60)).toEqual([429, 429]);
    expect((await post(body())).status).toBe(204);               // another session is unaffected
  });

  it("ignores obvious bots without storing", async () => {
    const res = await post(body(), { origin: ORIGIN, "user-agent": "Googlebot/2.1" });
    expect(res.status).toBe(204);
    expect(db.rows("events")).toHaveLength(0);
  });

  it("an event is attributed only to the client owning the site key", async () => {
    await post(body({ site_key: "sk_B" }), { origin: "https://other.example" });
    expect(db.rows("events").map((e) => e.client_id)).toEqual([CB]);
  });
});

describe("collector abuse limits", () => {
  it("per-site event budget caps the total per minute across sessions", async () => {
    const codes: number[] = [];
    for (let i = 0; i < 1203; i++) codes.push((await post(body({ site_key: "sk_BUDGET" }), { origin: ORIGIN, "x-forwarded-for": `10.1.${i % 250}.${(i >> 8) + 1}` })).status);
    expect(codes.filter((c) => c === 204)).toHaveLength(1200);
    expect(codes.slice(1200)).toEqual([429, 429, 429]);
    expect((await post(body())).status).toBe(204);                 // other sites unaffected
  });

  it("per-IP limit applies across sessions, is per site, and the ip is never stored", async () => {
    const h = { origin: ORIGIN, "x-forwarded-for": "198.51.100.7, 10.0.0.1" };
    const codes: number[] = [];
    for (let i = 0; i < 122; i++) codes.push((await post(body({ site_key: "sk_IP" }), h)).status);   // new session each time
    expect(codes.filter((c) => c === 204)).toHaveLength(120);
    expect(codes.slice(120)).toEqual([429, 429]);
    expect((await post(body({ site_key: "sk_IP" }), { origin: ORIGIN, "x-forwarded-for": "198.51.100.8" })).status).toBe(204);
    expect(JSON.stringify(db.rows("events"))).not.toContain("198.51.100");
  });

  it("accepts the business-type events and stores them under the site's client", async () => {
    for (const event of ["signup", "trial_start", "demo_booked", "lead"]) {
      expect((await post(body({ event }))).status, event).toBe(204);
    }
    expect((await post(body({ event: "paid", value: 4999, currency: "INR" }))).status).toBe(204);
    expect(db.rows("events").map((e) => e.name)).toEqual(["signup", "trial_start", "demo_booked", "lead", "paid"]);
    expect(db.rows("events").at(-1)).toMatchObject({ value: 4999, currency: "INR" });
    for (const event of ["page_view", "add_to_cart", "form_submit", "purchase"]) expect((await post(body({ event }))).status, event).toBe(204);
  });

  it("new events still reject personal-data fields, unknown names and implausible paid values", async () => {
    for (const k of ["email", "phone", "name", "mobile"]) {
      expect((await post(body({ event: "signup", [k]: "x" }))).status, k).toBe(400);
    }
    expect((await post(body({ event: "signup", props: { email: "a@b.c" } }))).status).toBe(400);   // strict schema
    expect((await post(body({ event: "signup_complete" }))).status).toBe(400);
    expect((await post(body({ event: "paid", value: 5e8, currency: "INR" }))).status).toBe(400);
    expect(db.rows("events")).toHaveLength(0);
  });

  it("implausible purchase value is rejected and not stored; plausible one is kept", async () => {
    expect((await post(body({ event: "purchase", value: 5e8, currency: "INR" }))).status).toBe(400);
    expect(db.rows("events")).toHaveLength(0);
    expect((await post(body({ event: "purchase", value: 250000, currency: "INR" }))).status).toBe(204);
    expect(db.rows("events")).toHaveLength(1);
  });

  it("body is read as a stream and abandoned once it passes 4 KB (no content-length)", async () => {
    let pulled = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(c) { if (pulled++ < 200) c.enqueue(new Uint8Array(1024).fill(97)); else c.close(); },
    });
    const res = await POST(new Request("http://localhost/api/collect", { method: "POST", headers: { origin: ORIGIN }, body: stream, duplex: "half" } as RequestInit));
    expect(res.status).toBe(413);
    expect(pulled).toBeLessThan(20);
  });
});

describe("OPTIONS /api/collect", () => {
  const pre = (origin: string | null, k = "sk_A") =>
    OPTIONS(new Request(`http://localhost/api/collect?k=${k}`, { method: "OPTIONS", headers: origin ? { origin, "access-control-request-method": "POST" } : {} }));
  it("allows only the site's allowed origins", async () => {
    const ok = await pre(ORIGIN);
    expect(ok.status).toBe(204);
    expect(ok.headers.get("access-control-allow-origin")).toBe(ORIGIN);
    expect(ok.headers.get("access-control-allow-methods")).toMatch(/POST/);
    const bad = await pre("https://evil.example");
    expect(bad.status).toBe(403);
    expect(bad.headers.get("access-control-allow-origin")).toBeNull();
    expect((await pre(ORIGIN, "unknown")).status).toBe(404);
    expect((await pre(null)).status).toBe(403);
  });
});
