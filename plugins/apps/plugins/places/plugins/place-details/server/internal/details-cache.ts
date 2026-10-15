import { createInflight } from "@plugins/packages/plugins/inflight/core";

/** How long one place's answer is reused: a day, the most Google's terms allow in spirit. */
export const DETAILS_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * A per-key memo of a fetched answer, kept `ttlMs`, with concurrent misses
 * collapsed onto one fetch. In memory: a restart costs one fetch per key asked
 * again. A fetch that throws is not kept — the next ask retries.
 */
export function createTtlMemo<V>(ttlMs: number, now: () => number = Date.now) {
  const kept = new Map<string, { at: number; value: V }>();
  const inflight = createInflight();
  return {
    async get(key: string, fetch: () => Promise<V>): Promise<V> {
      const hit = kept.get(key);
      if (hit !== undefined && now() - hit.at < ttlMs) return hit.value;
      return inflight.run(key, async () => {
        const value = await fetch();
        const at = now();
        // Drop what has expired, so the memo holds at most a day of keys.
        for (const [k, v] of kept) if (at - v.at >= ttlMs) kept.delete(k);
        kept.set(key, { at, value });
        return value;
      });
    },
  };
}
