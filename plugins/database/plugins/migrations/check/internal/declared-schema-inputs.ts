import { join, relative } from "path";
import { asPluginId } from "@plugins/framework/plugins/plugin-id/core";
import type { ServerContribution } from "@plugins/framework/plugins/server-core/core";
import {
  registerBarrelStubs,
  importBarrel,
} from "@plugins/plugin-meta/plugins/barrel-import/core";
import {
  buildRegistryGenContext,
  type CodegenPass,
} from "@plugins/framework/plugins/tooling/plugins/codegen/core";
import { View } from "@plugins/database/plugins/derived-views/server";
import { DerivedTable } from "@plugins/database/plugins/derived-tables/server";
import { registeredDerivedUpdatedAt } from "@plugins/database/plugins/derived-updated-at/server";
import {
  DbTrigger,
  DbTriggerClaim,
} from "@plugins/database/plugins/db-triggers/server";
import {
  SchemaStampPart,
  type SchemaLayerInputs,
} from "@plugins/database/plugins/migrations/server";
import {
  forkExclusionsFrom,
  type ForkExclusions,
} from "@plugins/database/plugins/admin/server";

export type DeclaredSchemaInputsResult =
  | { ok: true; inputs: SchemaLayerInputs; forkExclusions: ForkExclusions }
  | { ok: false; message: string };

// The derived schema inputs main's next boot would install after its migrations
// — views, rollup tables, derived-`updatedAt` triggers — read from this
// checkout's server barrels. A booted backend gets the first two from
// `View.getContributions()` / `DerivedTable.getContributions()`; a check process
// never boots, so it imports the barrels itself and reads each definition's
// `contributions` — the same walk `config_v2`'s `registrations-paired` check
// does. Only plugins in main's composition closure count: a plugin main does not
// bundle contributes nothing on main.
//
// The `updatedAt` specs are not contributions: `defineEntity` registers them at
// module eval, so importing the barrels (which import every `tables.ts` a boot
// loads) fills the same module registry boot reads.
//
// The same walk yields the fork exclusions main's plugins declare
// (`ExcludeFromFork` / `ExcludeSchemaDataFromFork`): what the migration shadow,
// a fork of main, leaves out — the set every worktree fork leaves out.
//
// An empty view set or spec set means the walk loaded nothing it should have —
// this repo declares both — so it fails rather than dry-running a layer that
// tests nothing.
export async function declaredSchemaInputs(
  pass: CodegenPass,
): Promise<DeclaredSchemaInputsResult> {
  const { root } = pass;
  const ctx = await buildRegistryGenContext(pass);
  registerBarrelStubs(root);

  type Definition = { contributions?: readonly ServerContribution[] };
  const definitions: Definition[] = [];
  // The machine barrels count for the fork exclusions and the stamp parts: a backend on this
  // computer boots them too (`infra/jobs` declares graphile's queue there), so
  // a fork that skipped them would copy main's pending jobs.
  const machineDefinitions: Definition[] = [];
  for (const node of ctx.tree.byDir.values()) {
    if (!ctx.mainBundle.has(asPluginId(node.id))) continue;
    // Which barrels it has is already on the node (the tree read every key
    // file to build it): a stat per plugin here was ~1.8k file calls of this
    // check's own on every slow-path pass.
    for (const runtime of ["server", "machine"] as const) {
      if (!node.runtimes[runtime]) continue;
      const index = join(node.dir, runtime, "index.ts");
      let mod: Record<string, unknown>;
      try {
        mod = await importBarrel(index);
      } catch (err) {
        return {
          ok: false,
          message: `Failed to import ${runtime} barrel ${relative(root, index)}: ${String(err)}`,
        };
      }
      const def = mod.default as Definition | undefined;
      if (def)
        (runtime === "server" ? definitions : machineDefinitions).push(def);
    }
  }

  const inputs: SchemaLayerInputs = {
    views: View.from(definitions),
    derivedTables: DerivedTable.from(definitions),
    updatedAtSpecs: registeredDerivedUpdatedAt(),
    triggers: DbTrigger.from(definitions),
    claimedTriggerSets: DbTriggerClaim.from(definitions).map((c) => c.id),
    // From the machine barrels too: the job queue's part is `infra/jobs#machine`'s.
    stampParts: SchemaStampPart.from([...definitions, ...machineDefinitions]),
  };
  if (inputs.views.length === 0) {
    return {
      ok: false,
      message: `No View contribution found in main's ${definitions.length} server barrel(s) — the barrel walk loaded nothing it should have.`,
    };
  }
  if (inputs.updatedAtSpecs.length === 0) {
    return {
      ok: false,
      message: `No derived-updatedAt spec registered after importing main's ${definitions.length} server barrel(s) — the schema files did not load into this process's registry.`,
    };
  }
  return {
    ok: true,
    inputs,
    forkExclusions: forkExclusionsFrom([...definitions, ...machineDefinitions]),
  };
}
