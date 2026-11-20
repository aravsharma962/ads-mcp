import { describe, it, expect, beforeEach } from "vitest";
import { FakeDb } from "@/test/fakeDb";
import { assertWithinCap, recordUsage, CapReachedError, monthlyCap } from "./usage";

let db: FakeDb;
const now = new Date("2026-11-20T10:00:00Z");
beforeEach(() => {
  db = new FakeDb();
  process.env.AI_MONTHLY_TOKEN_CAP = "1000";
});

describe("usage cap", () => {
  it("passes when under the cap", async () => {
    db.rows("usage_events").push({ tenant_id: "t1", tokens_in: 300, tokens_out: 200, created_at: "2026-11-02T00:00:00Z" });
    await expect(assertWithinCap("t1", { db: db as any, now })).resolves.toBeUndefined();
  });
  it("throws CapReachedError at the cap", async () => {
    db.rows("usage_events").push({ tenant_id: "t1", tokens_in: 600, tokens_out: 400, created_at: "2026-11-02T00:00:00Z" });
    await expect(assertWithinCap("t1", { db: db as any, now })).rejects.toBeInstanceOf(CapReachedError);
  });
  it("only counts this tenant and this month", async () => {
    db.rows("usage_events").push(
      { tenant_id: "t2", tokens_in: 5000, tokens_out: 0, created_at: "2026-11-02T00:00:00Z" },
      { tenant_id: "t1", tokens_in: 5000, tokens_out: 0, created_at: "2026-10-31T23:59:59Z" },
    );
    await expect(assertWithinCap("t1", { db: db as any, now })).resolves.toBeUndefined();
  });
  it("sums more than one page of rows", async () => {
    for (let i = 0; i < 2300; i++) db.rows("usage_events").push({ tenant_id: "t1", tokens_in: 1, tokens_out: 0, created_at: "2026-11-05T00:00:00Z" });
    process.env.AI_MONTHLY_TOKEN_CAP = "2200";
    await expect(assertWithinCap("t1", { db: db as any, now })).rejects.toBeInstanceOf(CapReachedError);
  });
  it("default cap is 200000 and bad values fall back", () => {
    delete process.env.AI_MONTHLY_TOKEN_CAP;
    expect(monthlyCap()).toBe(200000);
    process.env.AI_MONTHLY_TOKEN_CAP = "abc";
    expect(monthlyCap()).toBe(200000);
  });
  it("recordUsage writes one row", async () => {
    await recordUsage({ tenantId: "t1", userId: "u1", provider: "claude", tokensIn: 10, tokensOut: 5 }, { db: db as any });
    expect(db.rows("usage_events")).toHaveLength(1);
    expect(db.rows("usage_events")[0]).toMatchObject({ tenant_id: "t1", user_id: "u1", provider: "claude", tokens_in: 10, tokens_out: 5 });
  });
});
