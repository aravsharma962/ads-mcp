import { describe, it, expect, vi, beforeEach } from "vitest";
import { seedDb, req, params, UA_OWNER, UB_OWNER, CA, CB, TA } from "@/test/harness";
import type { FakeDb } from "@/test/fakeDb";

const state = vi.hoisted(() => ({ db: null as any, user: null as string | null, provider: null as any }));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => state.db.session(state.user) }));
vi.mock("@/lib/supabase/service", () => ({ createServiceClient: () => state.db }));
vi.mock("@/lib/hub", () => ({ callTool: vi.fn(), HubError: class extends Error {} }));
vi.mock("@/lib/ai", () => ({
  getProvider: () => state.provider(),
}));

import { POST } from "./clients/[clientId]/chat/route";

let db: FakeDb;
const OTHER_CONV = "c0000000-0000-4000-8000-0000000000bb";
beforeEach(() => {
  db = seedDb();
  db.rows("conversations").push({ id: OTHER_CONV, tenant_id: "22222222-2222-4222-8222-222222222222", client_id: CB, user_id: UB_OWNER });
  state.db = db;
  state.user = UA_OWNER;
  state.provider = () => ({ name: "fake", complete: async () => ({ text: "Hello", toolCalls: [], tokensIn: 1, tokensOut: 1 }) });
});
const post = (id: string, body: unknown) => POST(req(`/api/clients/${id}/chat`, { method: "POST", body }), params({ clientId: id }));

describe("POST chat", () => {
  it("streams events and creates a conversation in the caller's tenant", async () => {
    const res = await post(CA, { message: "hi", tenant_id: "evil" });
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('"type":"conversation"');
    expect(body).toContain('"type":"text"');
    expect(body).toContain('"type":"done"');
    expect(db.rows("conversations")[1]).toMatchObject({ tenant_id: TA, client_id: CA, user_id: UA_OWNER });
  });
  it("404 for another agency's client, nothing created", async () => {
    const res = await post(CB, { message: "hi" });
    expect(res.status).toBe(404);
    expect(db.rows("conversations")).toHaveLength(1);
  });
  it("404 when continuing another agency's conversation", async () => {
    expect((await post(CA, { message: "hi", conversation_id: OTHER_CONV })).status).toBe(404);
    expect((await post(CA, { message: "hi", conversation_id: "nope" })).status).toBe(404);
    expect(db.rows("messages")).toHaveLength(0);
  });
  it("rejects empty or oversized messages and signed-out callers", async () => {
    expect((await post(CA, { message: "" })).status).toBe(400);
    expect((await post(CA, { message: "x".repeat(4001) })).status).toBe(400);
    state.user = null;
    expect((await post(CA, { message: "hi" })).status).toBe(401);
  });
  it("rate limits to 20 messages per minute per tenant, other tenants unaffected, window resets", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date("2031-01-01T00:00:00Z"));
      const codes: number[] = [];
      for (let i = 0; i < 21; i++) {
        const res = await post(CA, { message: "hi" });
        codes.push(res.status);
        if (res.status === 200) await res.text();
      }
      expect(codes.slice(0, 20).every((c) => c === 200)).toBe(true);
      expect(codes[20]).toBe(429);
      const limited = await post(CA, { message: "hi" });
      expect((await limited.json()).error).toBe("You are sending messages too quickly. Wait a minute and try again.");
      const convs = db.rows("conversations").length;
      await post(CA, { message: "again" });
      expect(db.rows("conversations")).toHaveLength(convs);          // a limited request creates nothing
      state.user = UB_OWNER;
      expect((await post(CB, { message: "hi" })).status).toBe(200);
      state.user = UA_OWNER;
      vi.setSystemTime(new Date("2031-01-01T00:01:01Z"));
      expect((await post(CA, { message: "hi" })).status).toBe(200);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("POST chat: ordering and stream safety", () => {
  it("provider not configured: 503 and no conversation is created", async () => {
    state.provider = () => { throw new Error("no key"); };
    const res = await post(CA, { message: "hi" });
    expect(res.status).toBe(503);
    expect(db.rows("conversations")).toHaveLength(1);
  });
  it("monthly cap reached: refused and no conversation is created", async () => {
    process.env.AI_MONTHLY_TOKEN_CAP = "10";
    try {
      db.rows("usage_events").push({ tenant_id: TA, user_id: UA_OWNER, tokens_in: 100, tokens_out: 100, created_at: new Date().toISOString() });
      const res = await post(CA, { message: "hi" });
      expect(res.status).toBe(429);
      expect((await res.json()).error).toMatch(/limit/i);
      expect(db.rows("conversations")).toHaveLength(1);
    } finally {
      delete process.env.AI_MONTHLY_TOKEN_CAP;
    }
  });
  it("a stuck provider is cut off with an error event before maxDuration", async () => {
    state.provider = () => ({ name: "fake", complete: () => new Promise(() => {}) });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    try {
      const res = await post(CA, { message: "hi" });
      const textP = res.text();
      await vi.advanceTimersByTimeAsync(56_000);
      const body = await textP;
      expect(body).toContain('"type":"error"');
      expect(body).toMatch(/too long/i);
    } finally {
      vi.useRealTimers();
    }
  });
  it("client disconnect mid-stream does not throw", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    state.provider = () => ({ name: "fake", complete: async () => { await gate; return { text: "late", toolCalls: [], tokensIn: 1, tokensOut: 1 }; } });
    const res = await post(CA, { message: "hi" });
    const reader = res.body!.getReader();
    await reader.read();
    await reader.cancel();
    release();
    await new Promise((r) => setTimeout(r, 20));
  });
});
