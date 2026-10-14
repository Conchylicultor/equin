import { join } from "node:path";
import type {
  Check,
  CheckResult,
} from "@plugins/framework/plugins/tooling/core";
import { REPO_ROOT } from "@plugins/infra/plugins/paths/core";
import {
  parseBarrelExports,
  readIfExists,
} from "@plugins/plugin-meta/plugins/parse-utils/core";
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
import type * as QueryResourceServerBarrel from "@plugins/infra/plugins/query-resource/server";
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

/** Absolute path of a barrel specifier's `index.ts`. */
function barrelIndexPath(specifier: string): string {
  return join(
    REPO_ROOT,
    specifier.replace("@plugins/", "plugins/"),
    "index.ts",
  );
}

/**
 * `server-core/core` re-presents the resource runtime from `resources.ts` rather
 * than declaring it in the barrel, so its exports are read from both files. Any
 * other barrel is read from its `index.ts` alone.
 */
function barrelExportNames(specifier: string): Set<string> {
  const names = new Set<string>();
  const dir = join(REPO_ROOT, specifier.replace("@plugins/", "plugins/"));
  for (const file of ["index.ts", "resources.ts"]) {
    const src = readIfExists(join(dir, file));
    if (src == null) continue;
    for (const e of parseBarrelExports(src)) names.add(e.name);
  }
  return names;
}

const check: Check = {
  id: "resource-vocabulary:barrels-name-their-exports",
  description:
    "Every name in the resource vocabulary (`tooling/resource-vocabulary/core`) is really exported by the barrel its entry names. The vocabulary's key set is derived from the barrels' module types — a missing factory or marker is already a `tsc` error — but each entry's `barrel` field is read only by scanner error messages, so nothing else would notice it pointing at the wrong plugin.",
  scope: "tree",

  run(): Promise<CheckResult> {
    const offenders: string[] = [];
    const entries: [string, { barrel: string }][] = [
      ...Object.entries(resourceDescriptorFactories),
      ...Object.entries(resourceRegisterMarkers),
      ...Object.entries(resourceServingPrimitives),
    ];

    for (const [name, entry] of entries) {
      const exported = barrelExportNames(entry.barrel);
      if (exported.size === 0) {
        offenders.push(
          `${name}: declared barrel ${entry.barrel} has no readable barrel file ` +
            `(looked for ${barrelIndexPath(entry.barrel)})`,
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
      return Promise.resolve({
        ok: false,
        message:
          `Resource vocabulary entries name a barrel that does not export them:\n    ` +
          offenders.join("\n    ") +
          `\n\n  Fix the entry's \`barrel\` in ` +
          `plugins/framework/plugins/tooling/plugins/resource-vocabulary/core/index.ts. ` +
          `The field is quoted verbatim in the resources-facet error a developer sees ` +
          `when a descriptor cannot be resolved, so a wrong one sends them to the wrong plugin.`,
      });
    }

    return Promise.resolve({ ok: true });
  },
};

export default check;
