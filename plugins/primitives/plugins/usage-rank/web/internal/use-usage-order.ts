import { useEffect, useRef } from "react";
import { useLive } from "@plugins/network/plugins/live/web";
import {
  legacyDraftKeys,
  readDraft,
  writeDraft,
} from "@plugins/primitives/plugins/persistent-draft/web";
import { defineStore } from "@plugins/primitives/plugins/dom/plugins/web-storage/web";
import { z } from "zod";
import {
  sortByUsage,
  usageKey,
  usageStats,
  type ScorableStat,
  type UsageStat,
} from "../../core";

// The last snapshotted order per namespace, so the FIRST paint after a mount
// already shows the settled order. An id-set read is never preloaded (the
// server cannot know a client's id set at snapshot time), so the stats arrive
// one round-trip after mount; without this seed the strip would visibly
// re-sort on every single open.
//
// Longer than the default 7-day draft TTL: this is a rendering cache for a
// slow-moving order, not an in-flight edit. Expiring it only costs one
// re-sort flash, so a long TTL is free.
const orderStore = defineStore({
  owner: "usage-rank.order",
  label: "Usage orders",
  area: "local",
  cap: "128 KB",
  ttl: 90 * 24 * 60 * 60 * 1000,
  whenFull: "evict-oldest",
  schema: z.array(z.string()),
  legacy: legacyDraftKeys("usage-rank:order"),
});

interface OrderSnapshot {
  /** `(resnapshotKey, key-set)` — the identity of the frozen window. */
  stamp: string;
  order: readonly string[];
  /** True once the order was derived from settled server stats (vs. the seed). */
  settled: boolean;
}

/**
 * First-paint order for `keys`: the cached order for the keys still present,
 * then anything new in its incoming (authored) position at the tail.
 *
 * A brand-new key sorting last for one round-trip is the right trade: the
 * settled order — where a never-used key falls back to its authored slot — is
 * one push away, whereas a wrong-but-plausible seed for a key we have never
 * ranked would be indistinguishable from a real ranking.
 */
function seedOrder(
  namespace: string,
  keys: readonly string[],
): readonly string[] {
  const cached = readDraft(orderStore, { scope: namespace });
  if (cached === null) return [...keys];

  const present = new Set(keys);
  const taken = new Set<string>();
  const seeded: string[] = [];
  for (const entry of cached) {
    if (present.has(entry) && !taken.has(entry)) {
      taken.add(entry);
      seeded.push(entry);
    }
  }
  for (const key of keys) {
    if (!taken.has(key)) {
      taken.add(key);
      seeded.push(key);
    }
  }
  return seeded;
}

/** Join the wire rows (keyed by `usageKey`) back onto the caller's domain keys. */
function indexStats(
  namespace: string,
  keys: readonly string[],
  rows: readonly UsageStat[],
): ReadonlyMap<string, ScorableStat> {
  const byUsageKey = new Map(rows.map((row) => [row.usageKey, row]));
  const byKey = new Map<string, ScorableStat>();
  for (const key of keys) {
    const stat = byUsageKey.get(usageKey(namespace, key));
    if (stat) byKey.set(key, stat);
  }
  return byKey;
}

/**
 * Order `keys` most-used-first, FROZEN for as long as `resnapshotKey` and the
 * key set hold still.
 *
 * The freeze is the point of this hook, not an optimization: chips that
 * re-order on their own click are a guessing game, and muscle memory only pays
 * off if the strip is stable while the user works. So the order is snapshotted
 * exactly ONCE per `(resnapshotKey, key-set)` — at the first settled read — and
 * every later live push into the same window is ignored. Habits still surface
 * within minutes, at the next `resnapshotKey` (a conversation switch, a dialog
 * open — whatever the consumer decides is a fresh context).
 *
 * Living here rather than in each consumer means every future adopter gets the
 * stable ordering by default instead of re-deriving it per render.
 */
/* eslint-disable react-hooks/refs -- the frozen snapshot IS this hook's state and is read+written during render by design: holding it in a ref is precisely what makes a live push into the same window cause no re-render and no re-order, and the settled order must paint on the same pass it lands (state + an effect would show one frame of the pre-settle order). Localized here so no consumer needs the exemption. */
export function useUsageOrder(
  namespace: string,
  keys: readonly string[],
  resnapshotKey: string,
): readonly string[] {
  const ids = keys.map((key) => usageKey(namespace, key));
  // The canonical (sorted, deduped, comma-joined) id set — the SAME encoding
  // `useLive(c, { ids })` subscribes with, so the signature and the
  // subscription tuple can never drift, and re-ordering `keys` alone is not a
  // key-set change.
  const idsKey = usageStats.rows.point.encode(ids).ids;

  // ONE coalesced subscription for the whole visible set — not one sub per key.
  const result = useLive(usageStats, { ids });

  // Length-prefixed so the two halves cannot alias: `resnapshotKey` is an
  // opaque consumer string and ids may contain any separator we might pick.
  const stamp = `${resnapshotKey.length}:${resnapshotKey}:${idsKey}`;
  const snapshotRef = useRef<OrderSnapshot | null>(null);
  const held = snapshotRef.current;

  let snapshot: OrderSnapshot;
  if (held === null || held.stamp !== stamp) {
    // New window (context switched, or the key set itself changed): re-seed.
    snapshot = { stamp, order: seedOrder(namespace, keys), settled: false };
  } else if (!held.settled && result.status === "ready") {
    // The one and only re-derivation for this window: server truth landed.
    // (A failed read keeps the seed order — usage ranking is a nicety, and the
    // seed is already a complete, usable order.)
    const stats = indexStats(namespace, keys, result.data);
    snapshot = {
      stamp,
      // eslint-disable-next-line react-hooks/purity -- the ordering is a decay over wall-clock time, so `now` IS an input; it is read exactly once per snapshot (not per render), and the result is frozen immediately after
      order: sortByUsage(keys, stats, Date.now()),
      settled: true,
    };
  } else {
    snapshot = held;
  }
  snapshotRef.current = snapshot;

  useEffect(() => {
    // Cache only a SETTLED order: re-writing the seed would re-persist a
    // possibly-stale order and refresh its TTL on nothing but a mount.
    if (!snapshot.settled) return;
    writeDraft(orderStore, [...snapshot.order], { scope: namespace });
  }, [snapshot, namespace]);

  return snapshot.order;
}
/* eslint-enable react-hooks/refs */
