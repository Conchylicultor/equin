import { Resource } from "@plugins/framework/plugins/server-core/core";

// The preloaded resources, read GENERICALLY from the shared collection — never
// by naming a specific resource (collection-consumer separation). A resource
// opts in on its shared client descriptor (`preload: "boot"` or
// `"boot-and-keep"` — both preload); `Resource.Declare` derives the flag from the
// resource, so it appears here.
//
// Two kinds, told apart by the Declare payload alone:
// - a DEFAULT-TUPLE preload (a param-less value, a collection's default window):
//   one tuple, at the descriptor's `defaultParams` (else `{}`);
// - an ENUMERATED preload (a parameterized value): `preloadTuples` names and
//   loads its tuples, every one of which ships.
export function preloadedKeys(): string[] {
  return Resource.Declare.getContributions()
    .filter((c) => c.preload !== undefined)
    .map((c) => c.key);
}

/** The enumerated preloads: each key and the function loading its tuples. */
export function enumeratedPreloads(): {
  key: string;
  preloadTuples: NonNullable<
    ReturnType<
      typeof Resource.Declare.getContributions
    >[number]["preloadTuples"]
  >;
}[] {
  const out: ReturnType<typeof enumeratedPreloads> = [];
  for (const c of Resource.Declare.getContributions()) {
    if (c.preload !== undefined && c.preloadTuples !== undefined) {
      out.push({ key: c.key, preloadTuples: c.preloadTuples });
    }
  }
  return out;
}
