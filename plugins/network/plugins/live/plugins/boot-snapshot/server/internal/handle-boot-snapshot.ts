import { implement } from "@plugins/infra/plugins/endpoints/server";
import { crashFieldsOf } from "@plugins/packages/plugins/error-subject/core";
import {
  composedWebPlugins,
  keptSnapshotValue,
  loadResourceByKey,
  reportServerError,
  unboundedWindowKeys,
} from "@plugins/framework/plugins/server-core/core";
import { readPersistedSnapshots } from "@plugins/network/plugins/live/plugins/live-state-snapshot/server";
import { resourceDescriptorByKey } from "@plugins/network/plugins/live/plugins/live-state/core";
import { bootSnapshot } from "../../core";
import type { BootSnapshotSource } from "../../core";
import { enumeratedPreloads, preloadedKeys } from "./boot-keys";

type Params = Record<string, string>;

/**
 * A load the snapshot omits — still reported, so a lost hydration is never
 * silent. One report per key and page load (`what` names the tuple, or how many
 * of the key's tuples failed), carrying the first failure.
 */
function reportOmitted(key: string, what: string, err: unknown): void {
  const e = err instanceof Error ? err : new Error(String(err));
  reportServerError({
    message: `[boot-snapshot] ${key} ${what} not preloaded: ${e.message}`,
    ...crashFieldsOf(e),
    errorType: e.constructor.name !== "Error" ? e.constructor.name : null,
  });
}

// Serves every preloaded resource in one request so the client hydrates them
// all before first paint.
//
// Memory path first: a persisted alias (an unbounded-window `scopedMembership`
// key) keeps its whole value current in memory, while its L2 row trails it by
// up to one floor-persist window — so its kept snapshot is served when it holds
// one (`keptSnapshotValue`), never the older row.
//
// L2 fast path next: read the persisted `live_state_snapshot` values in ONE
// query (low-ms, no loaders on the hot request path) and serve those directly.
// The read serves only USABLE rows (live-state-snapshot's predicate: a key the
// runtime persists right now, under its current definition), so a bounded
// preloaded key never reaches it. Only keys with neither (first-ever boot, a
// newly-added resource before its first recompute, a bounded window) fall back
// to a from-scratch `loadResourceByKey` — the original behavior. A failed fallback loader is OMITTED (not fatal) so one broken
// resource never bricks the snapshot; that key falls back to its normal WS
// sub-ack. See
// research/2026-06-22-global-live-state-l2-persisted-materialization.md §3.4.
//
// An ENUMERATED preload (a parameterized value — see `boot-keys.ts`) is never
// L2-persisted: its served half names and loads its tuples (`preloadTuples` —
// the loader alone, no flight and no commit watermark, sequential per key),
// shipped under `tuples[key]`. A tuple whose loader fails is omitted and
// reported; the rest of the key still ships. Only the tuples a web plugin of
// the page's composition reads are loaded (`webPlugins`): the public website's
// page never reads the mail app's config documents. The serving backend passes
// its own composition's (`composedWebPlugins()`); a host rendering another
// composition's pages (the crawlable static host) passes that one's.
export async function assembleBootSnapshot(opts: {
  /**
   * The web plugins (dot-form ids) of the composition whose page boots from
   * this snapshot — what decides which enumerated tuples it carries.
   */
  webPlugins: ReadonlySet<string>;
  /**
   * Serve persisted aliases from memory (default true). Boot-bench's cold
   * mode turns it off, so a cleared L2 really measures the loaders.
   */
  memory?: boolean;
}): Promise<{
  resources: Record<string, unknown>;
  tuples: Record<string, { params: Params; value: unknown }[]>;
  timings: Record<string, { source: BootSnapshotSource; workMs: number }>;
  /** Wall time of the single batched persisted-snapshot read (the L2 fast path). */
  persistedReadMs: number;
}> {
  const enumerated = enumeratedPreloads();
  const enumeratedKeys = new Set(enumerated.map((e) => e.key));
  const preloaded = preloadedKeys().filter((k) => !enumeratedKeys.has(k));
  // The memory path: each persisted alias that holds a kept snapshot.
  const fromMemory = new Map<string, { value: unknown; workMs: number }>();
  if (opts.memory ?? true) {
    const aliases = new Set(unboundedWindowKeys());
    for (const k of preloaded) {
      if (!aliases.has(k)) continue;
      const s = performance.now();
      const value = keptSnapshotValue(k);
      if (value !== undefined) {
        fromMemory.set(k, { value, workMs: performance.now() - s });
      }
    }
  }
  const keys = preloaded.filter((k) => !fromMemory.has(k));
  const enumeratedLoads = Promise.all(
    enumerated.map(async ({ key, preloadTuples }) => {
      const s = performance.now();
      try {
        const loaded = await preloadTuples(opts.webPlugins);
        const ok: { params: Params; value: unknown }[] = [];
        const failed: { params: Params; error: unknown }[] = [];
        for (const t of loaded) {
          if (t.ok) ok.push({ params: t.params, value: t.value });
          else failed.push({ params: t.params, error: t.error });
        }
        const first = failed[0];
        if (first !== undefined) {
          reportOmitted(
            key,
            `${failed.length}/${loaded.length} tuple(s), first ${JSON.stringify(first.params)}`,
            first.error,
          );
        }
        return { key, tuples: ok, workMs: performance.now() - s };
      } catch (err) {
        // The enumeration itself failed: the whole key falls back to its
        // readers' sub-acks.
        reportOmitted(key, "(enumeration failed)", err);
        return { key, tuples: null, workMs: performance.now() - s };
      }
    }),
  );

  const t0 = performance.now();
  const persisted = await readPersistedSnapshots(keys);
  const persistedReadMs = performance.now() - t0;

  const missing = keys.filter((k) => !persisted.has(k));
  const loaded = await Promise.allSettled(
    missing.map(async (k): Promise<[string, unknown, number]> => {
      const s = performance.now();
      // A membership-bounded resource (never persisted) loads at its
      // descriptor's default params — e.g. a windowed resource's default
      // window — so the snapshot value lands on the SAME (key, paramsKey)
      // tuple the client hydrates and later subscribes to. Read generically
      // off the shared descriptor registry, never by resource name; a plain
      // global resource has no defaultParams and keeps the `{}` tuple.
      const v = await loadResourceByKey(
        k,
        resourceDescriptorByKey(k)?.defaultParams,
      );
      return [k, v, performance.now() - s];
    }),
  );

  const resources: Record<string, unknown> = {};
  const timings: Record<
    string,
    { source: BootSnapshotSource; workMs: number }
  > = {};
  for (const [k, { value, workMs }] of fromMemory) {
    resources[k] = value;
    timings[k] = { source: "memory", workMs };
  }

  // The persisted keys all share the single batched read, so there's no per-key
  // server work to attribute — amortize that one read across them for a directional
  // work number (the read is one query, not per-key).
  const persistedKeys = keys.filter((k) => persisted.has(k));
  const perPersisted =
    persistedKeys.length > 0 ? persistedReadMs / persistedKeys.length : 0;
  for (const k of persistedKeys) {
    resources[k] = persisted.get(k);
    timings[k] = { source: "persisted", workMs: perPersisted };
  }

  // A failed fallback loader stays OMITTED (never reaches resources/timings),
  // and is reported.
  loaded.forEach((r, i) => {
    if (r.status === "fulfilled") {
      const [k, v, workMs] = r.value;
      resources[k] = v;
      timings[k] = { source: "loader", workMs };
    } else {
      const k = missing[i]!;
      reportOmitted(
        k,
        JSON.stringify(resourceDescriptorByKey(k)?.defaultParams ?? {}),
        r.reason,
      );
    }
  });

  const tuples: Record<string, { params: Params; value: unknown }[]> = {};
  for (const e of await enumeratedLoads) {
    if (e.tuples === null) continue;
    tuples[e.key] = e.tuples;
    timings[e.key] = { source: "loader", workMs: e.workMs };
  }
  return { resources, tuples, timings, persistedReadMs };
}

export const handleBootSnapshot = implement(bootSnapshot, () =>
  assembleBootSnapshot({ webPlugins: composedWebPlugins() }),
);
