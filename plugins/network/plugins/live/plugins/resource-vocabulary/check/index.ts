import type {
  Check,
  CheckResult,
  RepoFiles,
} from "@plugins/framework/plugins/tooling/core";
import { parseBarrelExports } from "@plugins/plugin-meta/plugins/parse-utils/core";
import { resolveSpecifier } from "@plugins/plugin-meta/plugins/plugin-records/plugins/specifier/core";
import {
  resourceDescriptorFactories,
  resourceRegisterMarkers,
  resourceServingPrimitives,
  type ServedCollectionFnNames,
  type ServedResourceFnNames,
} from "../core";
// Type-only NAMESPACE imports: the derivation below needs each barrel's whole
// module type, and an inline `typeof import("…")` would bypass the boundary
// system (it is not an import statement the checker can see). `import type * as`
// is a real, checkable edge that still erases completely.
import type * as ServerCoreBarrel from "@plugins/framework/plugins/server-core/core";
import type * as QueryResourceServerBarrel from "@plugins/network/plugins/live/plugins/query-resource/server";
import type * as LiveServerBarrel from "@plugins/network/plugins/live/server";

// The register-marker half of the vocabulary's completeness assertion.
//
// The descriptor-factory half lives in `../core`, where `satisfies
// Record<MintingFactoryName, …>` derives its key set from the `core` barrels'
// module types (`live-state`, `network/live`). The register
// markers cannot be derived there: they come from `query-resource/server` and
// `network/live/server`, and runtime isolation grants `core -> core` only. A
// `check/` file has no runtime restriction (it already imports server barrels
// across the repo), so the same derivation runs here instead.
//
// The type assertion below is the load-bearing half — it fails at `type-check`,
// not at check time. The RUN half verifies the one field types cannot see: each
// entry's `barrel`, which is quoted verbatim in scanner error messages ("add it
// to …") and is otherwise read by nothing, so it rots silently.

type ServingMarkerName =
  | ServedResourceFnNames<typeof ServerCoreBarrel>
  | ServedResourceFnNames<typeof QueryResourceServerBarrel>
  | ServedResourceFnNames<typeof LiveServerBarrel>
  | ServedCollectionFnNames<typeof LiveServerBarrel>;

type Assert<T extends true> = T;

/**
 * A register marker exported from any of the three barrels and missing from
 * `resourceRegisterMarkers` is a `tsc` error here. This is how
 * `windowQueryResource` went missing for the whole bounded-membership migration:
 * it was added to `query-resource/server`, and two scanners' private name lists
 * just never learned about it.
 *
 * Exported so it is part of the contract rather than an unused local.
 */
export type RegisterMarkersAreComplete = Assert<
  typeof resourceRegisterMarkers extends Record<ServingMarkerName, unknown>
    ? true
    : false
>;

/**
 * And the other direction: an entry for a marker no barrel exports any more (a
 * rename, a deletion) is a `tsc` error too, so the vocabulary cannot accumulate
 * names that match nothing. The descriptor half gets this free from `satisfies`
 * excess-property checking; the marker half states it.
 */
export type RegisterMarkersAreLive = Assert<
  keyof typeof resourceRegisterMarkers extends ServingMarkerName ? true : false
>;

// ── The run half: every declared barrel really exports its name ────

/**
 * The names the barrel `specifier` publishes, read from the run's file set —
 * the barrel resolved by the module graph's own resolver
 * (`plugin-records/specifier`) — or null when it names no file of the set.
 */
async function barrelExportNames(
  repo: RepoFiles,
  specifier: string,
): Promise<Set<string> | null> {
  const file = resolveSpecifier("", specifier, (rel) => repo.has(rel));
  const src = file === null ? null : await repo.read(file);
  if (src === null) return null;
  return new Set(parseBarrelExports(src).map((e) => e.name));
}

const check: Check = {
  id: "resource-vocabulary:barrels-name-their-exports",
  description:
    "Every name in the resource vocabulary (`tooling/resource-vocabulary/core`) is really exported by the barrel its entry names. The vocabulary's key set is derived from the barrels' module types — a missing factory or marker is already a `tsc` error — but each entry's `barrel` field is read only by scanner error messages, so nothing else would notice it pointing at the wrong plugin.",
  scope: "tree",

  async run(ctx): Promise<CheckResult> {
    const repo = await ctx.repo();
    const offenders: string[] = [];
    const entries: [string, { barrel: string }][] = [
      ...Object.entries(resourceDescriptorFactories),
      ...Object.entries(resourceRegisterMarkers),
      ...Object.entries(resourceServingPrimitives),
    ];

    // Each declared barrel read once: the entries name a handful.
    const byBarrel = new Map<string, Promise<Set<string> | null>>();
    for (const [name, entry] of entries) {
      let names = byBarrel.get(entry.barrel);
      if (names === undefined)
        byBarrel.set(
          entry.barrel,
          (names = barrelExportNames(repo, entry.barrel)),
        );
      const exported = await names;
      if (exported === null) {
        offenders.push(
          `${name}: declared barrel ${entry.barrel} names no file of the checkout`,
        );
        continue;
      }
      if (!exported.has(name)) {
        offenders.push(
          `${name}: not exported by its declared barrel ${entry.barrel}`,
        );
      }
    }

    if (offenders.length > 0) {
      return {
        ok: false,
        message:
          `Resource vocabulary entries name a barrel that does not export them:\n    ` +
          offenders.join("\n    ") +
          `\n\n  Fix the entry's \`barrel\` in ` +
          `plugins/network/plugins/live/plugins/resource-vocabulary/core/index.ts. ` +
          `The field is quoted verbatim in the resources-facet error a developer sees ` +
          `when a descriptor cannot be resolved, so a wrong one sends them to the wrong plugin.`,
      };
    }

    return { ok: true };
  },
};

export default check;
