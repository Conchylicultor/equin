import {
  hydrateResource,
  resourceDescriptorByKey,
} from "@plugins/network/plugins/live/plugins/live-state/web";

/** The part of a boot snapshot the cache is seeded from (the endpoint's body, timings aside). */
export interface BootSnapshotValues {
  resources: Record<string, unknown>;
  tuples: Record<
    string,
    readonly { params: Record<string, string>; value: unknown }[]
  >;
}

/** What a hydrate pass could not seed: keys with no descriptor, entries whose value failed. */
export interface BootSnapshotHydration {
  /** Snapshot keys no evaluated descriptor registered (its module is not loaded). */
  missing: string[];
  /** `<key> <params>: <message>` per entry its client schema rejected. */
  failed: string[];
}

/**
 * Seed the live-state cache from a boot snapshot — THE hydrate path, shared by
 * the page's boot task and a static render (`primitives/dom/static-render`).
 *
 * The snapshot's keys are the authoritative set: each resolves to its client
 * descriptor through the live-state descriptor registry (populated when the
 * descriptor's module is evaluated). One bad entry (a value its client schema
 * rejects) must not stop every entry after it: each hydrate is isolated, and
 * every failure is returned for the caller to surface.
 */
export function hydrateBootSnapshot(
  snapshot: BootSnapshotValues,
): BootSnapshotHydration {
  const missing: string[] = [];
  const failed: string[] = [];
  const hydrate = (
    d: NonNullable<ReturnType<typeof resourceDescriptorByKey>>,
    params: Record<string, string> | undefined,
    value: unknown,
  ) => {
    try {
      hydrateResource(d, params, value);
    } catch (err) {
      failed.push(
        `${d.key} ${JSON.stringify(params ?? {})}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  };
  for (const key of Object.keys(snapshot.resources)) {
    const d = resourceDescriptorByKey(key);
    if (!d) {
      missing.push(key);
      continue;
    }
    // A descriptor with defaultParams (a windowed resource's default window)
    // hydrates at that tuple — the same one the server's fallback loader used
    // and the one a bare useLive(c) subscribes to. Plain global resources
    // keep the param-less tuple.
    hydrate(d, d.defaultParams, snapshot.resources[key]);
  }
  // An enumerated preload (a parameterized value) ships every tuple with its
  // params — canonical, the same tuple its readers subscribe.
  for (const [key, entries] of Object.entries(snapshot.tuples)) {
    const d = resourceDescriptorByKey(key);
    if (!d) {
      missing.push(key);
      continue;
    }
    for (const e of entries) hydrate(d, e.params, e.value);
  }
  return { missing, failed };
}
