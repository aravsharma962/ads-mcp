import { describe, it, expect, vi, beforeEach } from "vitest";
import { seedDb, req, params, UA_OWNER, UA_MEMBER, UB_OWNER, CA, CB, TA, TB } from "@/test/harness";
import type { FakeDb } from "@/test/fakeDb";

const state = vi.hoisted(() => ({ db: null as any, user: null as string | null }));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => state.db.session(state.user) }));
vi.mock("@/lib/supabase/service", () => ({ createServiceClient: () => state.db }));

import { GET, POST } from "./clients/[clientId]/conversations/route";

const CONV_A = "c0000000-0000-4000-8000-0000000000a1";
const CONV_B = "c0000000-0000-4000-8000-0000000000b1";
const CONV_A_MEMBER = "c0000000-0000-4000-8000-0000000000a2";
let db: FakeDb;

beforeEach(() => {
  db = seedDb();
  db.rows("conversations").push(
    { id: CONV_A, tenant_id: TA, client_id: CA, user_id: UA_OWNER, title: "A chat" },
    { id: CONV_A_MEMBER, tenant_id: TA, client_id: CA, user_id: UA_MEMBER, title: "member chat" },
    { id: CONV_B, tenant_id: TB, client_id: CB, user_id: UB_OWNER, title: "B secret chat" },
  );
  db.rows("messages").push(
    { id: 1, conversation_id: CONV_A, role: "user", content: { text: "hello A" } },
    { id: 2, conversation_id: CONV_B, role: "user", content: { text: "B confidential" } },
  );
  state.db = db;
  state.user = UA_OWNER;
});

const get = (qs: string, clientId = CA) => GET(req(`/api/clients/${clientId}/conversations${qs}`), params({ clientId }));

describe("conversations", () => {
  it("lists only the caller's own conversations for the client", async () => {
    const { conversations } = await (await get("")).json();
    expect(conversations.map((c: any) => c.id)).toEqual([CONV_A]);
  });
  it("reads own conversation with messages", async () => {
    const res = await get(`?id=${CONV_A}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.messages.map((m: any) => m.content.text)).toEqual(["hello A"]);
  });
  it("agency B cannot read agency A's conversation id: 404, no content", async () => {
    state.user = UB_OWNER;
    const res = await get(`?id=${CONV_A}`, CB);
    expect(res.status).toBe(404);
    expect(JSON.stringify(await res.json())).not.toContain("hello A");
  });
  it("agency B cannot read A's conversation through its own client path either", async () => {
    state.user = UB_OWNER;
    expect((await get(`?id=${CONV_A}`, CA)).status).toBe(404);
    expect((await get("", CA)).status).toBe(404);
  });
  it("a conversation id of the same agency but another client is 404", async () => {
    db.rows("clients").push({ id: "ca000000-0000-4000-8000-000000000002", tenant_id: TA, name: "A2", currency: "INR", timezone: "x" });
    expect((await get(`?id=${CONV_A}`, "ca000000-0000-4000-8000-000000000002")).status).toBe(404);
  });
  it("another member's conversation in the same agency is 404", async () => {
    expect((await get(`?id=${CONV_A_MEMBER}`)).status).toBe(404);
  });
  it("malformed id is 404", async () => {
    expect((await get("?id=1;drop")).status).toBe(404);
  });
  it("create ignores tenant, user and client ids from the body", async () => {
    const res = await POST(req(`/api/clients/${CA}/conversations`, { method: "POST", body: { title: "New", tenant_id: TB, user_id: UB_OWNER, client_id: CB } }), params({ clientId: CA }));
    expect(res.status).toBe(201);
    const { conversation } = await res.json();
    expect(db.rows("conversations").find((c) => c.id === conversation.id)).toMatchObject({ tenant_id: TA, client_id: CA, user_id: UA_OWNER, title: "New" });
  });
  it("create for another agency's client is 404", async () => {
    const res = await POST(req(`/api/clients/${CB}/conversations`, { method: "POST", body: {} }), params({ clientId: CB }));
    expect(res.status).toBe(404);
  });
  it("signed out is 401", async () => {
    state.user = null;
    expect((await get("")).status).toBe(401);
  });
});
