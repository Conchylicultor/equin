# Build-time plugin disable via `package.json`, with auto-computed dependent closure

## Context

Today there is no way to turn a plugin "off." Plugins are discovered from the
filesystem and every barrel's `contributions` are registered unconditionally.
"Hiding" a contribution via the reorder system is cosmetic — e.g. hiding the
`review.plugin-changes` review section does **not** stop its work, because
`ReviewButton` enumerates `Review.Section.useContributions()` directly and
renders each section's `summary`, which subscribes to the `pluginChangesResource`
live-state resource and fires the (expensive) worktree-vs-main plugin diff. The
only way to make a plugin behave "as if it didn't exist" is to stop registering
its contributions entirely — across **all** runtimes and out of the bundle.

A runtime gate (filtering `webEntries` in `loadPlugins`, or the `PluginProvider`
array) is insufficient: sibling plugins **statically import** a disabled plugin's
barrel (e.g. the ~10 `facets/*/render-diff` adapters do
`import { PluginChangesSlots } from "@plugins/review/plugins/plugin-changes/web"`),
and those edges are already compiled into the bundle — their module-eval
registration calls still fire. Only **codegen**, which controls what is emitted
and linked, can truly remove a plugin and its barrel. It does so via a
**dependent-closure cascade**: disabling X also disables every plugin that
transitively imports X, so nothing enabled imports a disabled barrel and the
disabled subtree tree-shakes out.

Intended outcome: add `"singularity": { "disabled": true }` to one plugin's
`package.json`, run `./equin build`, and that plugin + its entire dependent
closure vanish from `web/server/central.generated.ts` and the bundle, while the
Studio plugin tree still lists them, badged "disabled" (seed vs cascade). It is
intentionally OK to disable load-bearing plugins for experimentation — no safety
check blocks it; if boot breaks, the symmetric fix is unflag + rebuild.

## Design overview

1. **Seed flag** in each plugin's `package.json` under `singularity.disabled`,
   read by `buildPluginTree` (mirrors existing `singularity.collapsed` /
   `singularity.compositionRoot`). Only *seeds* are marked; cascade members are
   derived.
2. **Closure** computed from the existing `EdgeGraph` (`classifyEdges`): the
   fixpoint of `subtree` (descendants) ∪ `hardReverse` (transitive importers).
   A new ~12-line `disabledClosure()` next to the existing `hardClosure()`.
3. **Codegen omits the closure** from the registries and every config-origin
   generator; **annotates** it in docs; runtime needs no changes (shorter
   registries just work through the existing topo-sort/loader).
4. **Studio tree badge** sub-plugin renders "disabled" / "disabled (cascade)".

Because the flag is committed in `package.json`, the filter is **deterministic
from committed source**, so the `plugins-registry-in-sync` check (which
re-renders the registry from source and string-compares) stays green as long as
the filter is applied *unconditionally* inside the render — see
[In-sync interaction](#in-sync-check-interaction).

## The closure algorithm

Seeds = plugin ids whose `package.json` has `singularity.disabled === true`.

We must also disable:
- **Descendants** of a seed (`subtree`): a parent plugin's children make no sense
  without it.
- **Transitive importers** of any disabled plugin (`hardReverse`): they would
  crash at module-eval when their imported barrel is gone.

These interact (an importer has descendants; a descendant has importers), so it's
a single worklist fixpoint over the union of both relations:

```ts
// plugins/plugin-meta/plugins/closure/core/resolve-composition.ts (new export)
export function disabledClosure(seeds: Iterable<PluginId>, graph: EdgeGraph): Set<PluginId> {
  const out = new Set<PluginId>();
  const stack = [...seeds];
  while (stack.length) {
    const x = stack.pop()!;
    if (out.has(x)) continue;
    out.add(x);
    for (const d of graph.subtree.get(x) ?? []) if (!out.has(d)) stack.push(d);     // descendants
    for (const r of graph.hardReverse.get(x) ?? []) if (!out.has(r)) stack.push(r); // importers
  }
  return out;
}
```

**Edge-direction subtlety (the load-bearing detail):** we disable **dependents
(importers)** = `hardReverse`, *not* dependencies = `hardForward`. The existing
`hardClosure` walks `hardForward` (what a plugin needs) — the *opposite*
direction. Copy its shape but walk `hardReverse`.

**Why `hardReverse` is sufficient and complete:** `classifyEdges` builds
`hardReverse` from the cross-refs facet, which captures **all** `@plugins/A → @plugins/B`
ES imports — named, namespace, default, side-effect, **and type-only** — unioned
across **all** runtimes (web/server/central/core/shared). In this architecture you
cannot contribute to a slot without importing the owner's barrel object, so every
soft (slot) contributor is already a hard importer — `softReverse` adds nothing
for breakage. Imports of unknown/non-`@plugins` specifiers are dropped, which is
correct (they can't reference a plugin node).

Source: `plugins/plugin-meta/plugins/closure/core/{types.ts,classify-edges.ts,resolve-composition.ts,index.ts}`.
`EdgeGraph` already has `hardReverse` and `subtree` maps keyed by `PluginId`.

## 1. The `package.json` flag + `buildPluginTree`

**Schema addition** (per plugin, opt-in):

```jsonc
// plugins/review/plugins/plugin-changes/package.json
{ "name": "...", "private": true, "version": "0.0.1",
  "singularity": { "disabled": true } }
```

**Why `package.json`, not a barrel `definePlugin({ disabled })` field:** the flag
must be readable **without importing the plugin's code** — that's the entire
point (we are trying to *not* load disabled barrels, and to let them tree-shake).
`buildPluginTree` already reads `package.json` as text and never imports the
barrel for these fields. (Contrast `loadBearing`, which *is* a barrel field via
`parseBoolField` — wrong template here.)

**`buildPluginTree` change** —
`plugins/plugin-meta/plugins/plugin-tree/core/internal/plugin-tree.ts`:
- Add `disabled: boolean` to the internal `PluginNode` interface (~line 29–42).
- In `collectCoreFields` (~line 220–228), alongside the existing `collapsed` /
  `compositionRoot` reads:
  ```ts
  if (pkg.singularity?.disabled === true) disabled = true;
  ```
  This `node.disabled` is the **seed** flag only (package.json), the single
  source of truth that codegen and the tree API both consume.

## 2. Codegen: omit the closure

All registry/config generators run through
`plugins/framework/plugins/tooling/plugins/codegen/core/regen-pipeline.ts`. Each
already builds the plugin tree (directly or via the cached `buildEnrichedTree`).
Add a small shared helper that computes the closed disabled-id set once from a
tree:

```ts
// new: codegen/core/disabled-ids.ts
export function computeDisabledIds(tree: PluginTree): Set<PluginId> {
  const graph = classifyEdges(tree);
  const seeds = [...tree.byDir.values()].filter(n => n.disabled).map(n => n.id);
  return disabledClosure(seeds, graph);
}
```

`classifyEdges` operates on the **barrel-free** (`skipBarrelImport: true`) tree —
exactly what the registry phase (`collectEntries`) already uses — so this runs
safely in `regenerateRegistryCodegen` (phase 1), before any barrel import freezes
the ESM cache.

### 2a. Registry generators (MUST) — `plugin-registry-gen.ts`

`renderCollectedDirRegistry` already has a `bundle?: Set<string>` filter hook used
by composition builds (line ~254: `const entries = bundle ? allEntries.filter(e => bundle.has(e.id)) : allEntries`).
**Do not** reuse `bundle` — it's gitignored/composition-only and the in-sync
check never passes it. Instead apply the disabled filter **unconditionally**,
driven by the tree's seed flags:

```ts
const disabled = computeDisabledIds(tree);            // tree already built in collectEntries
const entries = (bundle ? allEntries.filter(e => bundle.has(e.id)) : allEntries)
  .filter(e => !disabled.has(e.id));
```

`survivingPaths` (built from `entries`) already prunes `dependsOn` to survivors,
so no dangling deps. The same cross-runtime `disabled` set is applied to
`web/server/central.generated.ts` independently — correct, because the closure is
computed cross-runtime once, so a plugin disabled because its *server* barrel
imports a seed is also dropped from `web.generated.ts`.

### 2b. Config-origin generators (MUST — data-loss risk)

A disabled plugin is omitted from the registry, so at runtime its config_v2
descriptors never register. If a generated config **origin** still references it,
`pruneOrphanedConfigFiles` sees a committed origin with no registered descriptor
and can **delete user override files**. So these MUST skip the closure:

- **`config-origin-gen.ts`** — in `discoverConfigs` (~line 37), `if (disabled.has(node.id)) continue;` before importing the plugin's `server/index.ts`.
- **`reorderable-slots-gen.ts`** — filter disabled-owned/contributed slots in both
  `collectReorderableSlotSet` (barrel-free; feeds the pre-barrel manifest) and
  `collectReorderableSlots` (enriched catalog).
- **`data-views-gen.ts`** — verify during impl: if it materializes config_v2
  origins keyed by plugin, apply the same filter; if it's purely descriptive,
  leave it.

> These are config_v2 origins → the orphan-prune hazard is the reason they can't
> be left unfiltered, unlike docs.

### 2c. Docs (ANNOTATE) — `docgen.ts`

Keep disabled plugins in `plugins-compact.md` / `plugins-details.md` / per-plugin
`CLAUDE.md` (they still exist as code), but **mark them**. Thread the closure into
rendering: a seed gets `(disabled)`, a cascade member gets `(disabled: needs <seed>)`.
`docgen` already iterates `tree.roots` / `tree.byDir.values()`; pass the
`disabledIds` (+ a seed lookup) into the renderers. Committed docs regenerate;
the `plugins-doc-in-sync` check re-derives the identical annotated output
(deterministic from committed `package.json`), so it stays green.

### 2d. Out of scope (low-risk follow-up)

`token-group-vars-gen.ts` and `customUtilities` emit CSS, not config origins or
runtime registrations. A disabled token-group plugin is an edge case; leave
unfiltered for v1 and note as follow-up.

## In-sync check interaction

`plugins-registry-in-sync`
(`checks/plugins/plugins-registry-in-sync/check/index.ts`) re-renders each
registry via `renderCollectedDirRegistry({ root, def })` **without** `bundle` and
string-compares to the committed file. This is exactly why the disabled filter
must be **unconditional** (driven by `node.disabled` from committed
`package.json`), not threaded through `bundle`: both the build's emission and the
check's re-render read the same committed flags → identical filtered output →
check passes. No special-casing, no new check. The same logic keeps
`plugins-doc-in-sync` green for the annotated docs.

**Pre-barrel ordering:** the registry filter runs in phase 1
(`regenerateRegistryCodegen`) on the `skipBarrelImport` tree, before
`setPreBarrelImportGuard` arms and before the first barrel import. Config-origin /
reorderable-slots filtering happens in their existing phase-2 slots — unchanged
ordering, just fewer nodes. No new freeze-point risk.

## 3. Studio tree "disabled" badge

The tree node carries only the **seed** flag. Cascade membership is a closure
computation, which the Studio server already has the inputs for.

- **API node** — `plugins/plugin-meta/plugins/plugin-view/core/types.ts`: add
  `disabled: boolean` (in closure) and `disabledSeed: boolean` (package.json flag).
- **Server** — `plugins/plugin-meta/plugins/plugin-view/server/internal/tree-handler.ts`:
  it already calls `buildPluginTree(..., { skipBarrelImport: true })`. Add
  `classifyEdges` + `disabledClosure`, then in `toApiNode` set
  `disabledSeed = node.disabled` and `disabled = closure.has(node.id)`.
- **Badge sub-plugin** — new
  `plugins/apps/plugins/studio/plugins/explorer/plugins/disabled/`, mirroring the
  `load-bearing` sub-plugin exactly:
  ```ts
  // web/index.ts
  Explorer.TreeRowBadge({ id: "disabled", component: DisabledBadge })
  ```
  ```tsx
  // web/components/disabled-badge.tsx
  export function DisabledBadge({ node }: { node: PluginNode }) {
    if (!node.disabled) return null;
    const label = node.disabledSeed ? "Disabled" : "Disabled (cascade)";
    return <MdBlock className="size-3.5 text-muted-foreground" aria-label={label} />;
  }
  ```
  Per-node `if (!node.disabled) return null` guard is the universal pattern for
  this slot (every badge self-filters; the slot passes every node to every badge).

## Runtime: no changes

Once the registries omit the closure, `loadPlugins(webEntries)` receives a
shorter array, `topoSortPlugins` sorts fewer entries, and the server/central
registries never register the disabled routes/resources. Disabled barrels are no
longer statically reachable from any enabled plugin → tree-shaken from the bundle.
No `PluginProvider` filter, no boot-phase split, no `loadPlugins` change.

## Files to modify

| File | Change |
|---|---|
| `plugins/plugin-meta/plugins/closure/core/resolve-composition.ts` | New `disabledClosure()` (reverse + subtree fixpoint) |
| `plugins/plugin-meta/plugins/closure/core/index.ts` | Export `disabledClosure` |
| `plugins/plugin-meta/plugins/plugin-tree/core/internal/plugin-tree.ts` | `disabled` on `PluginNode`; read `singularity.disabled` in `collectCoreFields` |
| `plugins/framework/plugins/tooling/plugins/codegen/core/disabled-ids.ts` | New `computeDisabledIds(tree)` helper |
| `plugins/framework/plugins/tooling/plugins/codegen/core/plugin-registry-gen.ts` | Unconditional disabled filter in `renderCollectedDirRegistry` |
| `plugins/framework/plugins/tooling/plugins/codegen/core/config-origin-gen.ts` | Skip disabled nodes in `discoverConfigs` |
| `plugins/framework/plugins/tooling/plugins/codegen/core/reorderable-slots-gen.ts` | Filter disabled in both slot-set + catalog |
| `plugins/framework/plugins/tooling/plugins/codegen/core/data-views-gen.ts` | Verify + filter if it emits config origins |
| `plugins/framework/plugins/tooling/plugins/codegen/core/docgen.ts` | Annotate `(disabled)` / `(disabled: needs X)` |
| `plugins/plugin-meta/plugins/plugin-view/core/types.ts` | `disabled` + `disabledSeed` on API `PluginNode` |
| `plugins/plugin-meta/plugins/plugin-view/server/internal/tree-handler.ts` | Compute closure, set both fields in `toApiNode` |
| `plugins/apps/plugins/studio/plugins/explorer/plugins/disabled/**` | New badge sub-plugin (web barrel + component + package.json) |

## Verification

1. **Unit** — add `disabledClosure` test next to `closure.test.ts`: a seed pulls
   in descendants + transitive importers; an unrelated plugin is untouched;
   direction is reverse (a *dependency* of the seed is NOT disabled).
2. **End-to-end on the motivating case** — set
   `"singularity": { "disabled": true }` in
   `plugins/review/plugins/plugin-changes/package.json`, run `./equin build`.
   - Assert `web.generated.ts` / `server.generated.ts` no longer contain
     `review.plugin-changes`, its 2 children (`api-changes`, `file-changes`), or
     the ~10 `facets/*/render-diff` adapters (grep the generated files).
   - `./equin check plugins-registry-in-sync` passes (filter is
     deterministic).
   - Open `http://<worktree>.localhost:9000` on a conversation: the Review button
     shows **no** plugin-count summary chip, and `query_db` /
     debug live-state churn shows **no** `review.plugin-changes` resource
     subscription or recompute.
3. **Tree badge** — Studio → Explorer: `review.plugin-changes` shows "Disabled",
   the facet adapters show "Disabled (cascade)"; all still listed.
4. **Docs** — `plugins-compact.md` shows the annotations;
   `./equin check plugins-doc-in-sync` passes.
5. **Reversibility** — remove the flag, rebuild: registries, bundle, and docs
   return to the full set; checks green.
6. **Load-bearing experiment (no guard)** — flag a load-bearing plugin, rebuild,
   confirm the cascade lights up in the tree and (expected) boot may break;
   unflag + rebuild restores. Confirms the intentional no-safety-check behavior.
