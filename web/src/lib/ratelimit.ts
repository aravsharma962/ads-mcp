/**
 * Best-effort fixed-window rate limiter held in process memory. On serverless each instance has its own
 * counters, so this limits bursts per instance rather than giving an exact global limit.
 */
export type Limiter = { hit(key: string, now?: number): boolean; size(): number };

export function createLimiter(opts: { limit: number; windowMs: number; maxKeys?: number }): Limiter {
  const { limit, windowMs } = opts;
  const maxKeys = opts.maxKeys ?? 10_000;
  const map = new Map<string, { start: number; count: number }>();

  function trim(now: number) {
    if (map.size <= maxKeys) return;
    for (const [k, v] of map) if (now - v.start >= windowMs) map.delete(k);
    for (const k of map.keys()) {
      if (map.size <= maxKeys) break;
      map.delete(k); // oldest first (insertion order)
    }
  }

  return {
    hit(key, now = Date.now()) {
      const cur = map.get(key);
      if (!cur || now - cur.start >= windowMs) {
        map.delete(key);
        map.set(key, { start: now, count: 1 });
        trim(now);
        return true;
      }
      if (cur.count >= limit) return false;
      cur.count++;
      return true;
    },
    size: () => map.size,
  };
}
