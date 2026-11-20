import { describe, it, expect, vi, beforeEach } from "vitest";
import { hardenedSession, seedDb, req, params, UA_OWNER, UA_MEMBER, UB_OWNER, CA, CB } from "@/test/harness";
import type { FakeDb } from "@/test/fakeDb";

const state = vi.hoisted(() => ({ db: null as any, user: null as string | null }));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => hardenedSession(state.db, state.user) }));
vi.mock("@/lib/supabase/service", () => ({ createServiceClient: () => state.db }));

import { GET, POST, PUT } from "./clients/[clientId]/site/route";
import { trackingHealth } from "@/lib/tracking";

let db: FakeDb;
const NOW = new Date("2026-11-20T12:00:00Z");
const ago = (h: number) => new Date(NOW.getTime() - h * 3600_000).toISOString();

beforeEach(() => {
  db = seedDb();
  state.db = db;
  state.user = UA_OWNER;
});

const call = (fn: typeof GET, clientId: string, body?: unknown, method = "GET") =>
  fn(req(`/api/clients/${clientId}/site`, { method, body }), params({ clientId }));

describe("site route", () => {
  it("owner creates a site with normalized origins and a generated key", async () => {
    const res = await call(POST, CA, { allowed_origins: ["https://Shop.Example/some/path?x=1", "http://localhost:3000"], client_id: CB, tenant_id: "evil" }, "POST");
    expect(res.status).toBe(201);
    const { site } = await res.json();
    expect(site.site_key).toMatch(/^sk_[A-Za-z0-9_-]{20,}$/);
    expect(site.allowed_origins).toEqual(["https://shop.example", "http://localhost:3000"]);
    expect(db.rows("sites")).toHaveLength(1);
    expect(db.rows("sites")[0].client_id).toBe(CA);
  });

  it("rejects bad origins and duplicate site creation", async () => {
    for (const bad of [["javascript:alert(1)"], ["not a url"], [""], "https://x.example", Array(25).fill("https://a.example")]) {
      expect((await call(POST, CA, { allowed_origins: bad }, "POST")).status).toBe(400);
    }
    expect((await call(POST, CA, { allowed_origins: ["https://a.example"] }, "POST")).status).toBe(201);
    expect((await call(POST, CA, { allowed_origins: ["https://a.example"] }, "POST")).status).toBe(409);
  });

  it("member can read but not create, update or rotate", async () => {
    await call(POST, CA, { allowed_origins: ["https://a.example"] }, "POST");
    state.user = UA_MEMBER;
    expect((await call(GET, CA)).status).toBe(200);
    expect((await call(POST, CA, { allowed_origins: ["https://b.example"] }, "POST")).status).toBe(403);
    expect((await call(PUT, CA, { rotate_key: true }, "PUT")).status).toBe(403);
  });

  it("owner updates origins and rotates the key (old key stops existing)", async () => {
    const created = (await (await call(POST, CA, { allowed_origins: ["https://a.example"] }, "POST")).json()).site;
    const up = await (await call(PUT, CA, { allowed_origins: ["https://z.example"] }, "PUT")).json();
    expect(up.site.allowed_origins).toEqual(["https://z.example"]);
    expect(up.site.site_key).toBe(created.site_key);
    const rot = await (await call(PUT, CA, { rotate_key: true }, "PUT")).json();
    expect(rot.site.site_key).not.toBe(created.site_key);
    expect(db.rows("sites").map((s) => s.site_key)).toEqual([rot.site.site_key]);
    expect((await call(PUT, CA, {}, "PUT")).status).toBe(400);
  });

  it("update on a client without a site is 404", async () => {
    expect((await call(PUT, CA, { rotate_key: true }, "PUT")).status).toBe(404);
  });

  it("another agency gets 404 for every method and never sees the site key", async () => {
    db.rows("sites").push({ id: "s9", client_id: CA, site_key: "sk_SECRETKEY_A", allowed_origins: ["https://a.example"] });
    state.user = UB_OWNER;
    for (const [fn, m] of [[GET, "GET"], [POST, "POST"], [PUT, "PUT"]] as const) {
      const res = await call(fn, CA, m === "GET" ? undefined : { allowed_origins: ["https://x.example"], rotate_key: true }, m);
      expect(res.status).toBe(404);
      expect(await res.text()).not.toContain("SECRETKEY");
    }
    expect(db.rows("sites")[0].site_key).toBe("sk_SECRETKEY_A");
  });

  it("GET returns site and health", async () => {
    db.rows("sites").push({ id: "s1", client_id: CA, site_key: "sk_A", allowed_origins: [] });
    const { site, health } = await (await call(GET, CA)).json();
    expect(site.site_key).toBe("sk_A");
    expect(health).toEqual({ eventsLast24h: 0, sessionsMissingAdIds: 0, lastEventAt: null });
  });
});

describe("trackingHealth", () => {
  it("counts only the given client's events in the last 24h", async () => {
    db.rows("events").push(
      { client_id: CA, session_id: "s1", name: "page_view", ad_id: "1", ts: ago(1) },
      { client_id: CA, session_id: "s1", name: "form_submit", ad_id: "1", ts: ago(1) },
      { client_id: CA, session_id: "s2", name: "page_view", ad_id: null, ts: ago(2) },
      { client_id: CA, session_id: "s3", name: "page_view", ad_id: null, ts: ago(3) },
      { client_id: CA, session_id: "s3", name: "form_submit", ad_id: "5", ts: ago(2) },
      { client_id: CA, session_id: "old", name: "page_view", ad_id: null, ts: ago(30) },
      { client_id: CB, session_id: "b1", name: "page_view", ad_id: null, ts: ago(1) },
    );
    expect(await trackingHealth(state.db, CA, NOW)).toEqual({ eventsLast24h: 5, sessionsMissingAdIds: 1, lastEventAt: ago(1) });
    expect(await trackingHealth(state.db, CB, NOW)).toEqual({ eventsLast24h: 1, sessionsMissingAdIds: 1, lastEventAt: ago(1) });
  });
});
