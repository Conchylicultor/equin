import { setPreBarrelImportGuard } from "@plugins/plugin-meta/plugins/barrel-import/core";
import { generateBarrelStubs } from "./barrel-stubs-gen";
import { generateBrowserHosts } from "./browser-host-gen";
import { generateConfigOrigins } from "./config-origin-gen";
import { stampOverrideLegends } from "./override-legend-stamp";
import { generatePluginDocs } from "./docgen";
import { buildBarrelFreeTree } from "./barrel-free-tree";
import {
  buildRegistryGenContext,
  generatePluginRegistry,
} from "./plugin-registry-gen";
import { generateEagerTier } from "./eager-tier-gen";
import { generateTokenGroupVars } from "./token-group-vars-gen";
import {
  postWebManifests,
  preBarrelManifests,
  writePreBarrelManifest,
} from "./pre-barrel-manifests";
import { assertPreBarrelManifestsFresh } from "./pre-barrel-guard";
import { assertSlotsDeclared } from "./slot-declaration-guard";
import { syncPluginPackageNames } from "./package-names";
import { generateExemptRuleIds } from "./exempt-rule-ids-gen";

/**
 * Single source of truth for the ordered, non-migration **repo-tree** codegen
 * pipeline.
 *
 * The full `./singularity build` and the push-time `regen-generated` normalize
 * step MUST regenerate the identical set of repo-tree artifacts, in the identical
 * order — otherwise push can commit a tree the next full build doesn't reproduce
 * (dirtying main) and push-time in-sync checks miss drift. This module is that
 * shared pipeline so the two paths can never drift again. (Duplicating the call
 * list across build.ts and regen-generated.ts is exactly how the drift was
 * introduced.)
 *
 * Out of scope (NOT repo-tree codegen, handled by their own steps in build):
 *   - DB migrations (`generateMigration`) — stateful, build-only.
 *   - `writeCentralRoutesManifest`, `central.json`, `propagateConfigToUser` —
 *     these write under `~/.singularity/`, not the repo tree.
 *   - `seedAuthoredOverrides` (authored-override-seed.ts) — repo-tree, but
 *     **deliberately build-only**, and this exception is load-bearing: it mints
 *     `@review` markers, and `regen-generated` runs inside push's merge-driver
 *     path, followed by `git add -A && git commit --amend`. A marker minted from
 *     this shared pipeline would therefore be amended into a landing commit —
 *     i.e. an unreviewed default lands, which is the exact failure the marker
 *     exists to prevent. `regen-generated` asserts marker-FREE instead. Do not
 *     "unify" it in here.
 *
 * Split into two functions to preserve build's interleaving of DB/central steps:
 * build runs registry codegen early (before central spawns + migrations), then
 * the manifest codegen later (after migrations). `regen-generated` runs both
 * back-to-back. The order WITHIN each function is authoritative — keep the
 * ordering comments here as the record of why.
 */

/**
 * A per-step wrapper used by build to attach a profiler span to each generator
 * call. The default (used by `regen-generated`) just runs the step inline. `id`
 * and `label` mirror the build profiler's span identifiers so build keeps its
 * per-step granularity.
 */
export type CodegenStep = (
  id: string,
  label: string,
  run: () => Promise<void>,
) => Promise<void>;

const runInline: CodegenStep = (_id, _label, run) => run();

export interface RegenCodegenOptions {
  root: string;
  /** Optional per-step wrapper (build threads its profiler through this). */
  onStep?: CodegenStep;
}

export interface RegistryCodegenResult {
  /**
   * Plugin `package.json` files whose derived `"name"` was (re)written. Non-empty
   * means `bun.lock` — which records every workspace member's name — is stale
   * until dependencies are re-resolved; the caller that owns the install decides
   * how (build re-runs `ensureDeps`).
   */
  renamedPackages: string[];
}

/**
 * Registry-level repo-tree codegen: plugin package names + barrel stubs +
 * plugin registry.
 *
 * Runs FIRST in build — before central is spawned (its `plugins.generated.ts`
 * must be in sync) and before migrations. Barrel stubs must precede the registry
 * because registry generation imports barrels under the stub set.
 *
 * The plugin registry and the eager-tier manifest are both pure functions of the
 * SAME barrel-free tree + disabled closure, so one context is built here and
 * threaded through both — one tree walk, not two. The eager-tier step runs after
 * the registry (it consumes the same filtered web-entry set + `dependsOn` graph)
 * and may throw the reachability error, which correctly fails the build.
 *
 * Package names come first: they are a pure function of each plugin's path
 * (`packageNameFor`), read from the same memoized barrel-free tree the registry
 * context reuses, and nothing below reads them — first only so a renamed plugin
 * is reported before the heavier steps run.
 */
export async function regenerateRegistryCodegen({
  root,
  onStep = runInline,
}: RegenCodegenOptions): Promise<RegistryCodegenResult> {
  let renamedPackages: string[] = [];
  await onStep("packageNames", "plugin package names", async () => {
    renamedPackages = await syncPluginPackageNames({
      root,
      tree: await buildBarrelFreeTree(root),
    });
  });
  await onStep("barrelStubs", "barrel stubs", () =>
    generateBarrelStubs({ root }),
  );
  const ctx = await buildRegistryGenContext(root);
  await onStep("pluginRegistry", "plugin registry", () =>
    generatePluginRegistry({ root, ctx }),
  );
  await onStep("eagerTier", "eager-tier manifest", () =>
    generateEagerTier({ root, ctx }),
  );
  await onStep("browserHosts", "browser host graphs", () =>
    generateBrowserHosts(ctx),
  );
  return { renamedPackages };
}

/**
 * Manifest-level repo-tree codegen: pre-barrel manifests → the slot declaration
 * guard → post-web manifests → plugin docs → token-group-vars → config-origins.
 *
 * Ordering constraints (load-bearing — do not reorder):
 *   - PRE-BARREL manifests FIRST — the set is now defined by `preBarrelManifests`
 *     (codegen/core/pre-barrel-manifests.ts), not hand-listed here. These are
 *     generated source files that plugin barrels import at module-load (directly
 *     or transitively). Bun's ESM cache freezes a module on the first `import()`
 *     and a later disk write cannot invalidate it — so every one MUST be
 *     regenerated (via barrel-free renderers) BEFORE `generatePluginDocs`
 *     triggers the first barrel import. Otherwise `generateConfigOrigins`
 *     re-imports stale barrels, misses the new descriptor, and
 *     `pruneOrphanedConfigFiles` deletes the freshly-authored override. This is
 *     enforced structurally now, not just by ordering: the runtime guard
 *     (`assertPreBarrelManifestsFresh`, installed below as the one-shot
 *     pre-barrel-import guard) throws if any manifest is stale at the first
 *     barrel import, and the `pre-barrel-manifests-complete` static check proves
 *     no barrel reaches an unregistered `*.generated.ts` at load.
 *
 *     NB: customUtilities lives in the pre-barrel set because it IS
 *     barrel-reachable at module-load — the ui-kit web barrel's `cn` export pulls
 *     `lib/utils.ts`, which iterates `CUSTOM_UTILITY_REGISTRY` (from
 *     `custom-utilities.generated.ts`) at top level. Its renderer only reads
 *     app.css by path (no plugin tree), so generating it pre-barrel is sound; it
 *     was previously generated AFTER plugin docs, which was a latent freeze bug.
 *   - the SLOT DECLARATION GUARD next — it opens the web declaration pass every
 *     step below shares, and an undeclared slot must fail BEFORE
 *     `generateConfigOrigins` runs (a missing manifest row is a descriptor that
 *     never registers, which `pruneOrphanedConfigFiles` reads as an orphaned
 *     config file and deletes).
 *   - POST-WEB manifests next (`postWebManifests`) — a manifest whose renderer
 *     must IMPORT the web barrels to see the truth (reorderableSlots reads each
 *     plugin's `slots` declaration and each slot's `meta.reorderable`). It runs
 *     between the web and the server import phases: its own renderer imports the
 *     web barrels, and nothing has imported a server barrel yet, so
 *     `reorder/server` — the only reader — is loaded after the write. The
 *     complementary half is that NO WEB barrel may reach one of these, which
 *     `pre-barrel-manifests-complete` enforces.
 *   - plugin docs: AFTER the pre-barrel manifests — it builds the enriched plugin
 *     tree (importing every barrel), which token-group-vars / config-origins
 *     reuse. Importing the codegen barrel also installs the reorder per-slot
 *     contribution catalog as the default origin-annotations preparer, so origins
 *     carry the catalog comments.
 *   - token-group-vars: BEFORE the build-time CSS single-owner checks
 *     (`css-vars-single-owner`, `css-vars-supplied`) consume it; safe here since
 *     it only reads token-group descriptors.
 *   - config-origins: after everything above — depends on every config_v2
 *     directive registered above.
 *   - override legends: reads the same descriptor set as the origins.
 *   - exempt rule ids: after the guard is disarmed — it imports every lint
 *     barrel and every check module (the live rule set), none of which is a
 *     plugin runtime barrel, and nothing in this pipeline reads its output.
 */
export async function regenerateManifestCodegen({
  root,
  onStep = runInline,
}: RegenCodegenOptions): Promise<void> {
  // Pre-barrel phase: regenerate every barrel-reachable manifest before any
  // barrel import freezes the ESM cache. Set defined by `preBarrelManifests`.
  for (const m of preBarrelManifests) {
    await onStep(m.id, `${m.id} manifest`, () =>
      writePreBarrelManifest(m, root),
    );
  }

  // Arm the freeze-point guard: the first barrel import (inside generatePluginDocs)
  // now asserts every pre-barrel manifest is still fresh, turning the ordering
  // invariant into a loud runtime failure instead of silent config pruning.
  setPreBarrelImportGuard(() => assertPreBarrelManifestsFresh(root));
  try {
    // The web declaration pass happens here (inside both steps below, shared
    // and memoized): it imports every WEB barrel and nothing else, so the
    // freeze-point guard fires on the first of those imports, and no server
    // barrel has read the manifest yet.
    //
    // The GUARD runs before the manifest is written, and both run before any
    // config origin is generated. That order is load-bearing: an undeclared slot
    // is a missing manifest row, a missing row is a config descriptor that never
    // registers, and `pruneOrphanedConfigFiles` deletes config files with no live
    // descriptor. Failing first is what keeps a declaration mistake from costing
    // authored files.
    await onStep("slotDeclarations", "slot declaration guard", () =>
      assertSlotsDeclared(root),
    );
    // POST-WEB manifests: their renderers need those same declarations. The web
    // imports are ESM-cache hits for `generatePluginDocs` below, so this costs
    // one evaluation of each web barrel, not two.
    for (const m of postWebManifests) {
      await onStep(m.id, `${m.id} manifest`, () =>
        writePreBarrelManifest(m, root),
      );
    }
    await onStep("pluginDocs", "generate plugin docs", () =>
      generatePluginDocs({ root }),
    );
    await onStep("tokenGroupVars", "token-group vars manifest", () =>
      generateTokenGroupVars({ root }),
    );
    await onStep("configOrigins", "generate config origins", () =>
      generateConfigOrigins({ root }),
    );
    // After the origins: the stamp reads the same descriptor set. It writes
    // only comment lines into overrides that already exist (never a file, never
    // a marker), so unlike the seeder it belongs in this shared pipeline — push
    // normalizes a legend a runtime write or a hand edit dropped.
    await onStep("overrideLegends", "stamp config override legends", () =>
      stampOverrideLegends({ root }),
    );
  } finally {
    // Disarm so a guard never leaks into a later run / unrelated barrel import.
    setPreBarrelImportGuard(() => {});
  }
  await onStep("exemptRuleIds", "exempt rule-id union", () =>
    generateExemptRuleIds({ root }),
  );
}
