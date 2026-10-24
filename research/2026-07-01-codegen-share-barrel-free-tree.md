# Route the last two barrel-free tree builds through `buildBarrelFreeTree`

## Context

A prior fix (commit `a81c4c76e`, "perf(codegen): memoize barrel-free plugin tree
to kill redundant builds") introduced `buildBarrelFreeTree(root)` — a per-root
memoized `buildPluginTree(..., { skipBarrelImport: true })`. The barrel-free tree
is a pure function of hand-authored plugin source (facet extraction reads only
`.ts`/`.tsx`/`package.json`; no generated manifest feeds it), so it is byte-identical
for every `skipBarrelImport` caller in one build. Four codegen steps already share
the memo: `plugin-registry-gen`, `reorderable-slots-gen`, `token-group-vars-gen`,
and the config-origins preparers.

Two build-pipeline call sites still build their *own* uncached barrel-free tree,
each a redundant full ~840-plugin scan:

- `collectDataViews` — `data-views-gen.ts:73` (feeds the pre-barrel `dataViews`
  manifest). Measures ~1.3s in the build profile as its own separate
  `buildPluginTree(skipBarrelImport:true)` span.
- `collectAllPlugins` — `docgen.ts:131` (used by `collectCentralRoutes` in
  `build.ts:91`). Another separate barrel-free build, not currently profiled as
  its own span.

Routing both through the shared memo collapses the build to a **single**
barrel-free tree build. This is not a swing/hotspot (stable ~1.3s), just residual
redundant work — the win is a smaller cold/contended worst-case for the whole build.

## Change

### 1. `docgen.ts` — `collectAllPlugins` (line 130-133)

`buildBarrelFreeTree` is defined in the same module (line 179). Replace the direct
build with the memoized call:

```ts
export async function collectAllPlugins(root: string): Promise<PluginNode[]> {
  const tree = await buildBarrelFreeTree(root);
  return Array.from(tree.byDir.values());
}
```

No import changes: `resolve` and `buildPluginTree` remain used by `buildEnrichedTree`
(line 163) and `buildBarrelFreeTree` (line 182).

### 2. `data-views-gen.ts` — `collectDataViews` (line 72-75)

Replace the direct build with the memoized call (mirrors how `reorderable-slots-gen.ts`
imports `buildBarrelFreeTree` from `./docgen`):

```ts
const tree = await buildBarrelFreeTree(root);
```

Import cleanup (both symbols become unused after the swap — line 73 was their only use):
- Line 2: `import { join, resolve } from "path";` → `import { join } from "path";`
- Line 3: remove `import { buildPluginTree } from "@plugins/plugin-meta/plugins/plugin-tree/core";`
- Add `import { buildBarrelFreeTree } from "./docgen";`

The existing doc-comment above `collectDataViews` already explains why a barrel-free
tree is correct here; it stays accurate. Optionally tighten the "MUST stay
barrel-free" note to point at the shared memo, but no wording change is required.

## Why this is safe / byte-identical

- The memoized tree is the same object all four existing consumers already share;
  swapping two more read-only consumers onto it cannot change output. `collectDataViews`
  only reads `node.dir`/`node.id` + text-scans `web/**`; `collectAllPlugins` only reads
  the `routes` facet (statically extracted under `skipBarrelImport`) — neither mutates
  the tree.
- The memo is a per-process cache keyed by `root`. In-sync checks (`data-views-in-sync`)
  run in fresh processes with an empty cache, so they recompute identically — same as
  the already-shared `reorderable-slots-in-sync` / `plugins-registry-in-sync` checks.

## Critical files

- `plugins/framework/plugins/tooling/plugins/codegen/core/docgen.ts`
- `plugins/framework/plugins/tooling/plugins/codegen/core/data-views-gen.ts`

## Verification

1. `./equin build` — must succeed with no generated-output drift.
2. `git status` must be clean afterward (no changes to
   `plugins/primitives/plugins/data-view/shared/data-views.generated.ts`,
   `docs/plugins-*.md`, per-plugin `CLAUDE.md`, or the central-routes manifest).
3. `./equin check` — in particular `data-views-in-sync`, `type-check`, and the
   registry/doc in-sync checks must pass (confirms byte-identical output).
4. `bun test plugins/framework/plugins/tooling/plugins/codegen/core` — the codegen
   unit tests (`config-origin-gen.test.ts`, `plugin-registry-gen.test.ts`,
   `reorderable-slots-scan.test.ts`) still pass.
5. (Optional) Confirm in the build profile Gantt (Debug → Profiling) that the separate
   `collectDataViews` barrel-free span is gone / folded into the shared tree build.
