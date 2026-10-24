# `singularity` becomes a composition — Phase 1

Phase 1 of [`2026-08-17-global-composition-build-serve-model.md`](./2026-08-17-global-composition-build-serve-model.md).

## Context

A composition is a named subset of plugins. `sonata`, `website`, `pages` and ~25
others are entries in the `compositions` manifest; the app this repo actually
builds is not. Main builds from the committed full registry (`web.generated.ts`)
and never goes through `resolveComposition`, so every rule that holds for a
composition carries an "except for main" clause.

That clause blocks three things downstream: a coherent namespace rule (the main
app on a worktree is named after the checkout, not the composition), a `build`
with no flag that simply means one composition, and replacing the plugin-disabling
mechanism with composition excludes.

The outcome: `singularity` is an ordinary manifest entry whose closure is every
plugin, and a check proves that closure renders **byte-identical** committed
registries — so "main is a composition" becomes enforced rather than asserted.

Nothing about how main builds changes. `build` still passes `composition: null`
and still plans from `web.generated.ts`. Phase 1 establishes the identity; Phase 2
changes the CLI.

## Decision taken

**"Every plugin" is spelled `**`** — a root entry pattern added to the grammar.
The alternatives were enumerating ~33 top-level ids (a drift list: a new top-level
plugin silently falls out of main) or a manifest boolean (re-introduces the
"except for main" branch inside the closure engine). `**` is also the exact
spelling Phase 7 needs — `**` plus `!x.**` negatives — to replace
`singularity.disabled`.

---

## The stale override — expected, resolved by hand

Adding a manifest entry changes `compositionsConfig.defaults`, so
`config/plugin-meta/composition/compositions.origin.jsonc` re-renders with a new
`// @hash`. Any user-layer override written against the old hash goes stale:
`nonStaleOverrideContent` (`plugins/config_v2/core/internal/tier-logic.ts`)
returns `undefined` and the effective value falls back to the origin.

Verified state on this machine: 76 worktrees have a user-layer
`compositions.jsonc`. **Main's**
(`~/.singularity/config/singularity/plugin-meta/composition/compositions.jsonc`,
hash `33b55824e728`) differs from its origin by exactly two bytes of meaning —
`autoBuild: true` on `sonata` and `website`. That file is what keeps
`sonata.localhost:9000` and `website.localhost:9000` served: compose-serve reads
main's layered config and sweeps every namespace that is present but no longer
activated.

**This is by design and is not mitigated in code.** A config conflict is meant to
be resolved by hand through the existing three-way-merge flow — `propagate()`
captures a `compositions.ancestor.jsonc` base and surfaces the conflict. The code
seeds are NOT changed to paper over it.

Practical consequence to expect, not to prevent: on the first main build after
this lands, sonata and website deactivate. Re-acknowledge the conflict (or
re-toggle their serve switches in Studio → Compositions), and the next main build
re-serves them. The ~74 agent worktrees go stale lazily on their own next build,
with no behavioural effect — compose-serve is main-only, so `autoBuild` in a
worktree's user layer already does nothing.

---

## Step 1 — per-context dir-entry cache (prerequisite, lands alone)

**File:** `plugins/framework/plugins/tooling/plugins/codegen/core/plugin-registry-gen.ts`

The equivalence check (Step 5) renders each collected dir twice — once unfiltered,
once bundle-filtered. Today that re-runs `collectEntries` + `buildDepsForDir`,
which reads every `.ts`/`.tsx` under every plugin's `<dir>/` tree — the expensive
half of registry codegen.

Split the bundle-independent I/O onto the context:

```ts
interface DirEntryScan { allEntries: CollectedRawEntry[]; rawDeps: Map<string, string[]> }

export interface RegistryGenContext {
  root: string;
  tree: PluginTree;
  disabled: Set<string>;
  /** Per-`<dir>` filesystem scan, memoized for this context's lifetime. A ctx is
   *  a SNAPSHOT of the tree — the same contract `disabled` already has. */
  dirScans: Map<string, DirEntryScan>;
}
```

`collectEntriesWithDeps(ctx, dir, bundle?)` keeps its signature and output; it
reads through the cache. Behaviour-preserving, and it pays for itself immediately
elsewhere: `regen-pipeline.ts` already shares one ctx between the registry and
eager-tier generators (one duplicate `web` walk deleted per build), and
`compose-serve.ts` shares one ctx across every activated composition (2
compositions × 3 runtime dirs → 3 walks instead of 6).

## Step 2 — namespace vocabulary: reserved vs owned

`singularity` must become a legal composition **id** while staying a namespace
compose-serve may never provision (that namespace belongs to main's own build).
`RESERVED_COMPOSITION_NAMESPACES` membership does **not** change — only who calls
which assert.

The vocabulary currently lives in `plugin-registry-gen.ts`, which imports `fs` at
module scope, so web and server cannot reach it. The UI and the serve endpoint
both need to ask "is this servable?", so move it.

**New file:** `plugins/plugin-meta/plugins/composition/core/namespace.ts` (zero
imports), re-exported from `core/index.ts`:

- `MAIN_COMPOSITION_ID = "singularity"` — with a comment stating it coincides with
  `MAIN_WORKTREE_NAME` (`infra/paths`) only by the target model's elision rule;
  they are two axes (composition × checkout). **Do not alias them** — Phase 3 owns
  the relation.
- `COMPOSITION_NAME_RE`, `assertCompositionName` — moved verbatim.
- `RESERVED_COMPOSITION_NAMESPACES` — unchanged membership `{central, singularity, main}`.
- `isServableCompositionId(id)` — the non-throwing predicate the UI and the
  activated-set filter need.
- `assertServableCompositionNamespace(name)` — unchanged meaning.
- `assertCompositionId(id)` — **the split, in one function**: every id must be a
  valid name; every id *except* main's must also be servable.

`plugin-registry-gen.ts` deletes its copies and imports `assertCompositionName`.
Codegen core already imports `@plugins/config_v2/core` and two `plugin-meta`
packages, so this adds no new layer — but it does mint a `codegen → composition`
hard edge, which `composition-closure` must still find disjoint from sonata's and
website's `excludes`. Verify that; the fallback is a dependency-free leaf plugin
owning the vocabulary.

Call sites:

| File | Change |
|---|---|
| `checks/plugins/composition-closure/check/index.ts:106` | `assertServableCompositionNamespace(item.id)` → `assertCompositionId(item.id)` — the one line that makes `id: "singularity"` legal |
| `cli/bin/commands/internal/compose-serve.ts` `serveOne` | **unchanged** — still refuses `singularity` (defence in depth) |
| `plugins/build/plugins/serve-composition/server/internal/reset.ts:68` | **unchanged** — still refuses `singularity` |
| `codegen/core/plugin-registry-gen.test.ts:79–86` | retarget import; **add** the split assertions (`assertCompositionId("singularity")` does not throw; `assertServableCompositionNamespace("singularity")` still throws `"reserved namespace"`; `central`/`main` throw from both) |

`plugins/framework/plugins/server-core/bin/select-registry.ts` carries a
KEEP-IN-SYNC copy of the regex — boot cannot import config_v2, so keep the
duplication and retarget its comment at the new home.

## Step 3 — the root `**` entry pattern

**`plugins/plugin-meta/plugins/closure/core/entry-pattern.ts`** — make
`ParsedPattern` a discriminated union so `tsc` enumerates every consumer:

```ts
export type ParsedPattern =
  | { kind: "root"; negate: boolean; raw: string }
  | { kind: "id"; negate: boolean; base: PluginId; subtree: boolean; raw: string };
```

`parseEntryPattern` never throws (Studio render paths call it on user-typed
strings): after stripping `!`, a remainder of exactly `"**"` is the root form, so
`"!**"` parses cleanly and is rejected by the *check*, not by a crash.
`matchEntryPattern` on root returns every node id — move `allNodeIds(graph)` (today
a private helper at the bottom of `resolve-composition.ts`) here so "every node id
is a key of `hardForward`" has one spelling.

**The load-bearing invariant.** In `expandEntrySeeds`, a root positive seeds
everything and **names nothing**:

```ts
if (p.kind === "id") named.add(p.base);
for (const id of matchEntryPattern(p, graph)) seeds.add(id);
```

`named` is the protected set the negative pass refuses to trim. If `**` named
everything, `!x.**` could never remove anything and `composition-closure` would
reject every negative as dead — Phase 7 would be stillborn. Root means "everything
is in", not "everything is explicitly demanded".

Downstream consequences under `**`, all correct: every bundled node classifies
`required` (nothing is `entry`), `available` is empty, and any `selectedContributors`
entry would flag as redundant.

Call sites the union forces:

| File | Change |
|---|---|
| `closure/core/resolve-composition.ts` | the `kind === "id"` guard above; import `allNodeIds` |
| `closure/core/explain.ts` | **none** — reads `.seeds`, never `.base`. Comment only. |
| `closure/core/impact.ts` | **none** — operates purely on `selectedContributors` |
| `checks/.../composition-closure/check/index.ts` | rule 2 skips base-resolution for root; rule 3b puts root in `positiveSeeds`, never `namedBases`; **new rule**: `!**` refused ("would empty the bundle") |
| `checks/.../composition-closure` `containmentOf` | **none** — goes through `expandEntrySeeds(...).seeds`, so main's containment is every id. Correct: nothing is disjoint from main. |
| `cli/bin/commands/release.ts:286` | root → `continue`, falling into the existing "no app shell declaring `defineApp({iconKey})`" throw. `release --composition singularity` fails loudly, which is right. |
| `studio/.../entry-points/web/components/entry-editor.tsx` `shortName` | root → `` `${p.negate ? "!" : ""}**` ``. The picker only authors bare ids, so `**` stays unreachable from the UI. |
| `studio/plugins/graph/web/components/graph-view.tsx:45` | root → `null` seed → the existing empty-state search prompt. An 840-node graph has no meaningful single focus. |

Also update `plugins/plugin-meta/plugins/closure/CLAUDE.md` — add the `**` / `!**`
rows to the pattern table and the "root names nothing" invariant.

## Step 4 — the manifest entry

**File:** `plugins/plugin-meta/plugins/composition/core/config.ts`, **first**
element of the `default` array under its own `── The main app ──` banner. Array
position is Studio display order; `stableIdentity: true` keys by `id`, so a front
insert disturbs nothing.

```ts
{
  id: MAIN_COMPOSITION_ID,
  name: MAIN_COMPOSITION_ID,
  category: "app" as const,
  entryPoints: ["**"],
  selectedContributors: [] as string[],
  extends: [] as string[],
  excludes: [] as string[],
  autoBuild: false,
},
```

`extends: []` deliberately, not `["served-baseline"]`: `**` already covers it, and
extending would push served-baseline's bases into `named`, permanently shielding
them from any future negative.

No other seed changes. `sonata` and `website` keep `autoBuild: false` in code —
their serve state lives in main's user layer and its conflict is resolved by hand
(see above).

### What makes `autoBuild` inert on main

**Rung 1 — derive the activated set, so a stored `true` has no path to serving.**
`autoBuild` is a field on a homogeneous `listField`, so it cannot be made *absent*
on one row; rung 1 on the *effect* is reachable:

```ts
export function activatedCompositionIds(items: CompositionManifestItem[]): string[] {
  // "Activated" = servable AND opted in. Main's row can carry any autoBuild value
  // from any config layer and still never reach compose-serve.
  return items.filter((i) => i.autoBuild && isServableCompositionId(i.id)).map((i) => i.id);
}
```

This function lives in a CLI module `reset.ts` cannot import, while `reset.ts`
guard 4 hand-rolls the same `filter((i) => i.autoBuild)`. Move it beside the
vocabulary in `plugin-meta/composition/core` (it takes `CompositionManifestItem[]`,
whose type already lives there) and have both import it — one definition of
"activated".

**Rung 3 — `composition-closure` gains three manifest-shape rules:** exactly one
item has `id === MAIN_COMPOSITION_ID`; that item has `autoBuild: false`; and ids
are unique (the check enforces unique *names* today but not ids, which now double
as namespaces).

**Rung 4 — loud boundary:** `serveOne`'s existing throw stays;
`plugins/build/server/internal/handle-serve-composition.ts` gains a
`isServableCompositionId` 400 beside its `isMain()` guard.

## Step 5 — the equivalence proof

The claim, for every collected dir `d`:

```
renderCollectedDirRegistry({ ctx, def: d, bundle: <singularity's closure> })
  ===  renderCollectedDirRegistry({ ctx, def: d })      // byte-for-byte
```

The `disabled` filter is applied unconditionally on both sides so it cancels; the
only bundle-dependence in the renderer is `allEntries.filter(e => bundle.has(e.id))`
and the derived dep pruning. This *is* "main is a composition", mechanically.

**Fold it into `plugins-registry-in-sync`**
(`plugins/framework/plugins/tooling/plugins/checks/plugins/plugins-registry-in-sync/check/index.ts`)
rather than minting a new check. It already builds `ctx` and renders every def, so
with Step 1's cache the second render is pure string building; the additions are
two small file reads, one in-memory `classifyEdges(ctx.tree)`, one
`resolveComposition`. No prettier pass — both sides come from the same renderer
unformatted. It is also already the check that owns "what the committed registries
must equal", which is where Phase 7's seam will land.

After the existing per-def loop:

```ts
const manifests = readCompositionManifestsFromDisk(root);
const main = manifests.find((m) => m.id === MAIN_COMPOSITION_ID);
if (!main) return fail(`no "${MAIN_COMPOSITION_ID}" composition in the manifest registry`);
const graph = classifyEdges(ctx.tree);
const flat = flattenManifest(manifestItemToManifest(main), manifests.map(manifestItemToManifest));
const bundle = resolveComposition(graph, flat).bundle;
// reuse the `full` render already computed per def; compare against the filtered one
```

The failure message must name the **missing ids** (committed-registry entries
outside the closure), not just "these differ" — a bare diff verdict is useless when
it fires.

**Shared config read.** Both checks now need "the git-layer `compositions`
manifests, off disk, no server runtime". Extract `composition-closure`'s inline
`fileConfigProxy` + `HASH_RE` + `COMPOSITION_PLUGIN_ID` into codegen core beside
`readEffectiveConfigFromDisk` as `readGitLayerConfig(descriptor, {root, hierarchyPath})`
— keeping the strict hashless-file throw — plus a `readCompositionManifestsFromDisk(root)`
convenience. `composition-closure` loses ~40 lines.

**Free win while there:** `composition-closure` calls `buildPluginTree(..., {facets:true})`
directly, while `buildBarrelFreeTree(root)` (codegen core) memoizes the identical
call per root and is shared with every other check in the run. Switch it to
`buildRegistryGenContext(root).tree` and a redundant full faceted tree walk leaves
every check run.

## Step 6 — UI and write-path guards

| File | Change |
|---|---|
| `plugin-meta/composition/web/internal/manifests.ts` | `setAutoBuild` and `remove` refuse `MAIN_COMPOSITION_ID`. `save` may keep working (editing main's entry points is legitimate) — the equivalence check fails loudly on the next build if the edit narrows the closure, which is the point. |
| `studio/.../compositions/web/components/compositions-list.tsx` (`autoBuild` column) | render the `ToggleChip` `disabled` when `!isServableCompositionId(it.id)`, with `title="The main app is built by ./equin build — it is not compose-served."` Mirrors the inert-`canServe` pattern already in `serve-target-panel.tsx`. |
| same file (`serveUrl` column) | main's row links `singularity.localhost:9000` as already-live, or renders nothing — either way not keyed on `autoBuild`. |
| `build/plugins/serve-composition/web/components/serve-target-panel.tsx` | same inert treatment; suppress the reset button for main (`resetCompositionData` would refuse anyway). |
| `build/server/internal/handle-serve-composition.ts` | the 400 guard from Step 4. |

## Out of scope — explicitly

- **Do not reroute `generatePluginRegistry` through the composition bundle.** The
  committed `<dir>.generated.ts` files stay a pure function of the filesystem +
  `singularity.disabled`. Making them composition-dependent is Phase 7's problem,
  and it must first settle the importer-cascade semantics. Phase 1's check *proves*
  the two coincide; it does not merge the paths.
- **Do not add `--composition` to `build`, and do not touch `build.ts`.** Phase 2.
- **Do not emit `<dir>.composition.singularity.generated.ts` from any path.**
  `select-registry.ts` would pick it for the `singularity` namespace on the next
  backend spawn. It happens to be safe — byte-identical, by exactly the equivalence
  this phase proves — but nothing here should create it.
  (`build-composition --composition singularity` becomes newly *possible* as a side
  effect of the manifest entry. Note it; do not wire it.)
- **No namespace changes** — no `namespaceFor()`, no gateway `parseWorktree` /
  `registry.go` edits, no elision rule. Phase 3.
- **Do not weaken `assertServableCompositionNamespace`** or remove `singularity`
  from `RESERVED_COMPOSITION_NAMESPACES`. Its meaning is unchanged.
- **Do not touch compose-serve's stage wiring, `--serve-composition`, or the
  parent/child run shape.** Phases 4 and 8.

## Landing order

Four commits, each independently green:

1. **ctx dir-entry cache** (Step 1) — behaviour-preserving, pure perf.
2. **Namespace vocabulary move + `MAIN_COMPOSITION_ID` + `assertCompositionId`**
   (Step 2) — mechanical, `tsc`-driven, no manifest change, no hash churn.
3. **Root `**` grammar + call sites + closure tests** (Step 3) — still no manifest
   change, still no hash churn.
4. **Manifest entry + `autoBuild` containment + equivalence check + UI guards**
   (Steps 4–6) — the one that bumps the origin hash. Land it alone, as the parent
   doc says, and rebuild main immediately after.

## Verification

**Checks** (`./equin check <id>`):

- `composition-closure` — the manifest is valid, `singularity` is a legal id, no
  dead/contradictory negatives, and sonata's/website's `excludes` disjointness
  still holds **despite the new `codegen → composition` graph edge**. This is the
  one that could surprise you.
- `plugins-registry-in-sync` — both halves. **Break it once deliberately**
  (temporarily set the entry to `["apps.sonata.**"]`) and confirm the failure names
  the missing ids. A check never seen failing is a check not known to work.

  **Done — it fails correctly.** Narrowing the committed origin's `singularity`
  entry to `apps.sonata.**` produced:

  ```
  • plugins-registry-in-sync ... FAIL
    plugins/infra/plugins/paths/core/data-dirs.generated.ts contains 14 plugin(s)
    outside the "singularity" composition's closure:
    apps-core.surface.floating.wallpaper, apps.prototypes.files,
    apps.prototypes.thumbnails, database.embedded, database.zero.cache-service,
    framework.tooling.checks, framework.tooling.checks.type-check,
    framework.tooling.web-artifacts, infra.launcher, packages.signal-origin,
    primitives.css.layout-harness, release.bundles, reports, stats.cost
  ```

  The ids are the repair instruction: they say whether a plugin genuinely became
  unreachable or the manifest stopped meaning "everything".
- `config-origins-in-sync` — the re-rendered `compositions.origin.jsonc` is
  committed with its new hash.
- `config-stable-list-ids`, `type-check`, `format-clean`, `plugins-doc-in-sync`.
- Full `./equin check` green.

**Tests** (`./equin test <path>`):

- `plugins/plugin-meta/plugins/closure/core/closure.test.ts` — add:
  `parseEntryPattern("**")` / `("!**")` shapes; `matchEntryPattern` over root covers
  `tree.byDir.size`; **`expandEntrySeeds(["**"]).named.size === 0`** (the invariant
  everything rests on); `resolveComposition` under `**` gives `available === []` and
  every membership `"required"`; **`expandEntrySeeds(["**", "!apps.sonata.**"])`
  drops sonata and its subtree** (the Phase-7 forward guard); `["!**"]` seeds
  nothing (documents the pathology the check refuses).
- `plugins/plugin-meta/plugins/composition/core/config.test.ts` — the existing
  `"every seed carries autoBuild (default off)"` keeps passing unchanged
  (`singularity` is seeded `false` like every other). Add the main-entry
  assertions: exactly one seed with `id === MAIN_COMPOSITION_ID`, its
  `entryPoints` is `["**"]`, its `extends` is empty.
- `plugins/framework/plugins/tooling/plugins/codegen/core/plugin-registry-gen.test.ts`
  — the reserved/owned split; optionally a synthetic-tree property test that
  `render({ctx,def})` equals `render({ctx,def,bundle:allIds})` and differs for a
  bundle missing one id, pinning "a superset bundle changes nothing" as a renderer
  property.
- `plugins/framework/plugins/cli/bin/commands/internal/compose-serve.test.ts` —
  `activatedCompositionIds` drops `singularity` even at `autoBuild: true`.

**After `./equin build`:**

- `git status` clean — no committed registry moved. That is the whole point.
- `~/.singularity/worktrees/singularity/` still has **no** `composition.json`, and
  no `plugins/**/core/*.composition.singularity.generated.ts` exists anywhere.
- Build log: a `[config-v2] conflict` warning for `compositions` is **expected**,
  and `compose-serve: deactivated "sonata"` / `"website"` are the expected
  consequence on main's first build. Resolve the conflict by hand; the next main
  build re-serves both.
- Studio → Compositions: the `singularity` row appears first, its serve toggle is
  inert with the explanatory title, its delete affordance is gone; selecting it
  shows every plugin `required` and an empty `available` frontier.
- `query_db`: `select id, target, parent_id from build_runs order by started_at desc limit 6`
  — whatever children the (conflicted) config yields, but never a `-c-singularity`
  row. That is the assertion that matters: main's composition is never
  compose-served.
