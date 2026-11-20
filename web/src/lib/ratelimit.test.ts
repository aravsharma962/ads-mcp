import { describe, it, expect } from "vitest";
import { createLimiter } from "./ratelimit";

describe("createLimiter", () => {
  it("allows up to the limit per key per window, then blocks", () => {
    const l = createLimiter({ limit: 3, windowMs: 60_000 });
    expect([1, 2, 3, 4].map(() => l.hit("a", 0))).toEqual([true, true, true, false]);
    expect(l.hit("b", 0)).toBe(true);
  });
  it("resets after the window", () => {
    const l = createLimiter({ limit: 1, windowMs: 1000 });
    expect(l.hit("a", 0)).toBe(true);
    expect(l.hit("a", 999)).toBe(false);
    expect(l.hit("a", 1000)).toBe(true);
  });
  it("bounds memory by capping the number of keys", () => {
    const l = createLimiter({ limit: 1, windowMs: 1000, maxKeys: 10 });
    for (let i = 0; i < 100; i++) l.hit("k" + i, i * 10);
    expect(l.size()).toBeLessThanOrEqual(10);
    l.hit("late", 100_000);
    expect(l.size()).toBe(1);
  });
});
