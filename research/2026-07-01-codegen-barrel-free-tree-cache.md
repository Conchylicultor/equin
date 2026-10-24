# Codegen: memoize the barrel-free plugin tree (config-origins / token-group-vars perf)

## Context

After the plugin-registry N+1 was fixed (commit `f602e9619`: tree built once per
registry pass instead of once per collected-dir, span 11.8s → 2.5s), the dominant
codegen step became **`generate config origins`**, measured at **15.5s** in one build
but only **~2.3s** in a clean baseline. `token-group vars manifest` (~6s) was the
secondary suspect. The wide swing pointed at either redundant work (a rebuild N+1
like the one just fixed) or contention-bound I/O.

### Root cause (measured)

`generateConfigOrigins` does **not** rebuild the enriched plugin tree — that tree is
memoized (`enrichedTreeCache` in `docgen.ts:158`) and shared with `generatePluginDocs`,
and the per-node `importBarrel` calls in `discoverConfigs` are ESM-cache hits. The cost
is elsewhere:

`renderConfigOriginContent` (`config-origin-gen.ts:286`) resolves **two** reorder
origin preparers registered at `reorderable-slots-gen.ts:209` (annotations) and `:224`
(defaults). **Each** preparer calls `collectReorderableSlots` → `collectReorderableSlotSet`
→ `buildPluginTree(pluginsRoot, { skipBarrelImport: true })` (`reorderable-slots-gen.ts:81`)
— a full ~840-plugin **barrel-free** tree build that is **not memoized**. So config-origins
pays **two fresh barrel-free tree builds** back-to-back.

A barrel-free `buildPluginTree` build is not cheap: it runs `findAllPluginDirs` (whole-repo
glob walk), `collectCoreFields` ×840, `buildFsSnapshot` (reads every `.ts/.tsx/package.json`),
`loadFacets`, and the synchronous facet `extract`/`relate` passes over the snapshot.

**Measurement** (this worktree, `buildPluginTree(skipBarrel)` called 4× in one process):

```
#0: 3537ms   #1: 2568ms   #2: 2144ms   #3: 1733ms
```

~1.7–3.5s per build (cold higher; CPU-bound facet extraction + IO). config-origins does
2× of these → **~3.4s warm, ~12–15s cold/contended** — reproducing the reported
2.3s↔15.5s swing exactly. This is the perfs-skill "amplified event" signature: 2× an
uncached, IO/CPU-bound build whose absolute cost varies with page-cache warmth and machine
load, not a fixed hot op.

The **same uncached barrel-free build** recurs elsewhere in one `./equin build`:
- pre-barrel phase: `renderReorderableSlotsManifest` → `collectReorderableSlotSet` (1)
- `token-group-vars`: `collectTokenGroupVarsUncached` → its own `buildPluginTree(skipBarrel)`
  (`token-group-vars-gen.ts:84`) — its result is memoized (`collectCache`) but the tree
  build itself is a **separate** barrel-free build; its `importBarrel(webIndex)` calls are
  cache hits, so the tree build is its dominant cost too (the ~6s secondary suspect).
- registry context: `buildRegistryGenContext` → `buildPluginTree(skipBarrel)`
  (`plugin-registry-gen.ts:165`).

So a single build currently does **~5 barrel-free tree builds + 1 enriched build**.

### Why memoizing is byte-identical (not just "cheaper")

The barrel-free tree is a **pure function of hand-authored plugin source**. Its facet
extraction reads only `.ts/.tsx/package.json` under each plugin dir; grepping the facets
pipeline confirms **no facet reads any build-generated manifest**
(`reorderable-slots/data-views/token-group-vars/custom-utilities.generated.ts`) — facets
only touch their own `facet.generated.ts` registry. Therefore every `skipBarrelImport:true`
caller in a build gets an **identical** tree regardless of when the generated manifests are
(re)written, so reusing one build across all callers cannot change any downstream output.

This is the origin fix per the perfs methodology: the redundant builds **stop happening**
(they become cache reads), not merely run cheaper. It mirrors the two precedents already in
the tree: `enrichedTreeCache` (`docgen.ts:158`) and `RegistryGenContext` (commit `f602e9619`).

## Approach (structural: one shared barrel-free tree cache)

Introduce a memoized barrel-free tree builder — the exact twin of `buildEnrichedTree` —
and route every build-pipeline barrel-free caller through it, so one `./equin build`
does **exactly one** barrel-free build (+ one enriched).

### 1. Add `buildBarrelFreeTree(root)` (mirror `enrichedTreeCache`)

In `plugins/framework/plugins/tooling/plugins/codegen/core/docgen.ts`, beside
`enrichedTreeCache`/`buildEnrichedTree` (lines 158–167):

```ts
const barrelFreeTreeCache = new Map<string, Promise<PluginTree>>();

// The barrel-FREE plugin tree (skipBarrelImport) — a pure function of committed
// plugin source (facet extraction reads only .ts/.tsx/package.json; no generated
// manifest feeds it), so it is identical for every skipBarrelImport caller in a
// build. Memoized per root so one ./equin build does ONE barrel-free build,
// not one per codegen step. Twin of buildEnrichedTree.
export function buildBarrelFreeTree(root: string): Promise<PluginTree> {
  let cached = barrelFreeTreeCache.get(root);
  if (!cached) {
    cached = buildPluginTree(resolve(root, "plugins"), { skipBarrelImport: true });
    barrelFreeTreeCache.set(root, cached);
  }
  return cached;
}
```

Export it from `codegen/core/index.ts` (the `./docgen` re-export block).

Note it takes `root` (repo root) and applies `resolve(root, "plugins")` internally, so
every caller passes `root` uniformly (some callers today pass `pluginsRoot` — see wiring).

### 2. Route build-pipeline barrel-free callers through it

- **`reorderable-slots-gen.ts:81`** (`collectReorderableSlotSet`) — replace
  `await buildPluginTree(resolve(root, "plugins"), { skipBarrelImport: true })` with
  `await buildBarrelFreeTree(root)`. **This is the config-origins fix**: the two preparers
  now reuse the pre-barrel reorderableSlots build (cache already warm) → config-origins does
  **zero** barrel-free builds.
- **`token-group-vars-gen.ts:84`** (`collectTokenGroupVarsUncached`) — replace its
  `buildPluginTree(pluginsRoot, { skipBarrelImport: true })` with `buildBarrelFreeTree(root)`
  (`pluginsRoot` is `join(root,"plugins")`; the helper does the resolve). Keeps its own
  `collectCache` (result memo) — the change only shares the underlying tree.
- **`plugin-registry-gen.ts:165`** (`buildRegistryGenContext`) — replace its
  `buildPluginTree(pluginsRoot, { skipBarrelImport: true })` with `buildBarrelFreeTree(root)`.
  (`buildRegistryGenContext` receives `root`; drop the local `pluginsRoot` resolve.)

Reuse across the registry phase (early in build) and the manifest phase (later) is safe:
between them only central-spawn + migration generation run, and neither rewrites the
`.ts/.tsx/package.json` source the barrel-free tree reads.

### Concurrency / safety

- All post-return uses of the tree are **read-only** (`collectRenderSlotsStatic`,
  `computeDisabledIds`, `collectEntries`, the token-group `byDir` walk) — same sharing
  contract `enrichedTreeCache` already relies on. No caller mutates the returned tree.
- The cache is process-scoped, so the separate `./equin check` processes each build
  once (identical benefit, identical output).

### Files to modify

- `plugins/framework/plugins/tooling/plugins/codegen/core/docgen.ts` — add
  `buildBarrelFreeTree` + `barrelFreeTreeCache`.
- `plugins/framework/plugins/tooling/plugins/codegen/core/index.ts` — export it.
- `plugins/framework/plugins/tooling/plugins/codegen/core/reorderable-slots-gen.ts` — use it (line 81).
- `plugins/framework/plugins/tooling/plugins/codegen/core/token-group-vars-gen.ts` — use it (line 84).
- `plugins/framework/plugins/tooling/plugins/codegen/core/plugin-registry-gen.ts` — use it (line 165).

No signature changes to any public generator; only the internal tree-build call sites change.

## Verification

1. **Baseline first.** `./equin build` on the unchanged branch; note the
   `generate config origins` and `token-group vars manifest` span durations from the build
   profile (`~/.singularity/data/<worktree>/build-profile-<id>.json`, written by
   `writeBuildProfile`), and `git status` (clean generated tree).
2. Apply the change; `./equin build` again.
3. **Byte-identity (the hard gate):** `git status --short` must show **only** the 5 source
   files above — **no** drift in `config/**/*.origin.jsonc`, `plugins/reorder/shared/
   reorderable-slots.generated.ts`, the token-group-vars / data-views manifests, or any
   `*.generated.ts`.
4. **In-sync checks pass:** `./equin check config-origins-in-sync
   token-group-vars-in-sync reorderable-slots-in-sync plugins-registry-in-sync`
   (or full `./equin check`).
5. **Idempotence:** a second `./equin build` immediately after is a no-op tree
   (confirms `regen-generated` symmetry is preserved).
6. **Perf win:** in the new build profile, `generate config origins` drops from ~15s to
   sub-second and `token-group vars manifest` drops by roughly one barrel-free build.
   Optionally add a temporary counter/log inside `buildPluginTree` (skipBarrel branch) to
   assert it runs **once** per build process instead of ~5×; remove before pushing.
7. **Unit tests:** `bun test plugins/framework/plugins/tooling/plugins/codegen/core/config-origin-gen.test.ts
   plugins/framework/plugins/tooling/plugins/codegen/core/plugin-registry-gen.test.ts
   plugins/framework/plugins/tooling/plugins/codegen/core/reorderable-slots-scan.test.ts`
   (run after a build so `node_modules` is populated).

### Counterfactual exit test

Under the same load, the two config-origins preparer builds and the token-group build become
cache reads — the wasted barrel-free rebuilds **do not happen** (origin altitude), rather than
happening cheaper. The redundancy class is eliminated for every build-pipeline barrel-free
caller, matching the `enrichedTreeCache` / `RegistryGenContext` precedents.

## Notes / follow-ups

- The enriched tree (`buildEnrichedTree`, barrels imported) and the barrel-free tree remain
  **separate** caches by design: they carry different facet data (runtime facets need barrel
  imports) and the barrel-free build must stay barrel-free for the pre-barrel freeze-point
  invariant. Merging them is out of scope and would violate that invariant.
- Numerous `./equin check` plugins also call `buildPluginTree(skipBarrelImport:true)`
  directly (boundaries, facets, plugin-boundaries, …). Each already builds once per its own
  process, so they are out of scope here; they could adopt `buildBarrelFreeTree` later for
  cross-check sharing if a single check process ever runs several tree consumers.
