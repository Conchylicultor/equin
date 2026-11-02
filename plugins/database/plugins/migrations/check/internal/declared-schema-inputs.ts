import type { AppPath } from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
import { existsSync } from "fs";
import { join, relative } from "path";
import { asPluginId } from "@plugins/framework/plugins/plugin-id/core";
import type { ServerContribution } from "@plugins/framework/plugins/server-core/core";
import {
  registerBarrelStubs,
  importBarrel,
} from "@plugins/plugin-meta/plugins/barrel-import/core";
import { buildRegistryGenContext } from "@plugins/framework/plugins/tooling/plugins/codegen/core";
import { View } from "@plugins/database/plugins/derived-views/server";
import { DerivedTable } from "@plugins/database/plugins/derived-tables/server";
import { registeredDerivedUpdatedAt } from "@plugins/database/plugins/derived-updated-at/server";
import type { SchemaLayerInputs } from "@plugins/database/plugins/migrations/server";

export type DeclaredSchemaInputsResult =
  { ok: true; inputs: SchemaLayerInputs } | { ok: false; message: string };

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
// An empty view set or spec set means the walk loaded nothing it should have —
// this repo declares both — so it fails rather than dry-running a layer that
// tests nothing.
export async function declaredSchemaInputs(
  root: AppPath,
): Promise<DeclaredSchemaInputsResult> {
  const ctx = await buildRegistryGenContext(root);
  registerBarrelStubs(root);

  const definitions: { contributions?: readonly ServerContribution[] }[] = [];
  for (const node of ctx.tree.byDir.values()) {
    if (!ctx.mainBundle.has(asPluginId(node.id))) continue;
    const serverIndex = join(node.dir, "server", "index.ts");
    if (!existsSync(serverIndex)) continue;
    let mod: Record<string, unknown>;
    try {
      mod = await importBarrel(serverIndex);
    } catch (err) {
      return {
        ok: false,
        message: `Failed to import server barrel ${relative(root, serverIndex)}: ${String(err)}`,
      };
    }
    const def = mod.default as
      { contributions?: readonly ServerContribution[] } | undefined;
    if (def) definitions.push(def);
  }

  const inputs: SchemaLayerInputs = {
    views: View.from(definitions),
    derivedTables: DerivedTable.from(definitions),
    updatedAtSpecs: registeredDerivedUpdatedAt(),
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
  return { ok: true, inputs };
}
