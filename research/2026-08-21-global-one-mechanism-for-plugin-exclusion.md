# One mechanism decides whether a plugin is in the app — Phase 7

Phase 7 of [`2026-08-17-global-composition-build-serve-model.md`](./2026-08-17-global-composition-build-serve-model.md).

## Context

Two mechanisms answer one question — "is this plugin in the app?"

- **`singularity.disabled: true`** in a plugin's `package.json`. Codegen computes
  `computeDisabledIds` and omits the result from every registry, unconditionally.
- **Composition membership.** A plugin is in a composition's bundle or it is not,
  and `plugins-registry-in-sync` already proves that the committed registries
  equal what the `singularity` composition's closure renders.

Since Phase 1 landed, the second mechanism subsumes the first *in principle*:
`singularity` is an ordinary manifest row with `entryPoints: ["**"]`, and the
in-sync check proves its closure renders `web.generated.ts` byte-for-byte. What
kept them apart is that they resolve in opposite directions, and Phase 7 is the
work of collapsing that.

Outcome: `singularity.disabled` is deleted. A plugin leaves the app by being
negated out of a manifest, and the committed registries become the *definition* of
`singularity`'s closure rather than a thing proved equal to it.

---

## Audit — what is disabled today

One seed, eleven cascade members, cross-checked against `package.json`, the
committed docs, and the generated registries.

| | plugin |
|---|---|
| **seed** | `review.plugin-changes` (`3ec65537a` — its review-pane summary subscribed to `pluginChangesResource`, firing the worktree-vs-main diff on every render) |
| **descendants (2)** | `review.plugin-changes.api-changes`, `review.plugin-changes.file-changes` |
| **importers (9)** | `plugin-meta.facets.<f>.render-diff` for `contributions`, `cross-refs`, `db-schema`, `exports`, `registrations`, `resources`, `routes`, `slots`, `structure` |

All twelve are absent from `web.generated.ts` / `server.generated.ts` and carry
`(disabled)` / `(disabled — cascade)` in `docs/plugins-details.md` and their own
`CLAUDE.md`. Nothing else in the repo carries the flag.

**This is what makes the migration provable.** `!review.plugin-changes.**` with an
importer cascade resolves to exactly these twelve — the nine adapters are leaves
that nothing else imports — so the swap must leave every generated file
byte-identical. Byte-identity is the acceptance test, not a hope.

---

## The two problems being decided

### a. A negative cannot remove what an importer drags back

Disabling seeds a **reverse** closure: descendants ∪ transitive importers, so
disabling X removes everything that imports X. A composition is purely
**additive**: `bundle = hardClosure(entrySeeds ∪ selectedContributors)`, and the
negative pass only does `seeds.delete(t)`.

So `["**", "!review.plugin-changes.**"]` today would trim three ids from the seed
set, leave the nine adapters seeded, and `hardClosure` would walk their import
edges and **put `plugin-changes` straight back**. The exclude is silently ignored.

### b. A per-composition negative loses a global statement

`singularity.disabled` is one statement that holds everywhere. A negative written
on one manifest row holds for that row only — so a composition that seeds the same
plugins (`**`, or anything reaching `plugin-meta.facets`) would silently ship a
plugin the repo has decided it does not want. Today's other manifests happen not to
reach it, but that is an accident of the current rows, not a property.

### Decisions taken

1. **A negative cascades to importers.** `!X` removes X, its subtree, and
   everything that transitively imports X — the same reverse closure
   `disabledClosure` already computes. Refusing instead would make the author
   enumerate all nine adapters, and a tenth `render-diff` sibling added later would
   break the build for someone with no idea why.
2. **Exclusions are global by default, with a per-composition opt-out.** A reserved
   `base-exclusions` manifest row carries the negatives, and **every** composition
   inherits it — not by remembering to `extends` it, but because `flattenManifest`
   always folds it in. A composition takes a plugin back by naming it explicitly,
   which the existing protection rule already makes win over any negative.
3. **`singularity`'s manifest is committed-source only.** Codegen reads the git
   layer, so a user-layer edit to main's row cannot move a committed registry or a
   committed doc — it would be silently inert. The write is refused instead.

### Why a silent cascade is acceptable here

The cascade is not invisible. `plugins-compact.md`, `plugins-details.md` and every
per-plugin `CLAUDE.md` are committed and annotate each cascade member, so a
negative that takes twelve plugins with it shows up as twelve lines in the diff of
a review — which is exactly how today's `disabled` cascade is already read.

---

## Design

### 1. Global exclusions: a base row every composition inherits

`plugins/plugin-meta/plugins/closure/core/flatten-manifest.ts`

`flattenManifest` is already the single seam where `extends` is resolved, and every
engine entry point operates on an already-flattened manifest. Making the base row
implicit there is one line and cannot be forgotten:

```ts
visit(manifest);
if (manifest.name !== BASE_EXCLUSIONS_ID) visit(byName.get(BASE_EXCLUSIONS_ID));
```

The row itself is an ordinary manifest entry — same grammar, same check, same
Studio surface — holding only negatives:

```ts
{
  id: BASE_EXCLUSIONS_ID,          // "base-exclusions"
  name: BASE_EXCLUSIONS_ID,
  category: "pack" as const,
  entryPoints: ["!review.plugin-changes.**"],
  selectedContributors: [],
  extends: [], excludes: [], serve: "off",
}
```

`singularity`'s own row therefore stays `entryPoints: ["**"]`, unchanged. The
exclusion is stated once, globally — exactly the property the `package.json` flag
had, now expressed in the vocabulary that already decides membership.

**Reserved, and negatives-only.** `BASE_EXCLUSIONS_ID` joins the vocabulary in
`plugins/infra/plugins/namespace/core/namespace.ts` beside `MAIN_COMPOSITION_ID`,
and `assertCompositionId` treats it like main: a legal id, never a servable
namespace (nothing should be able to provision `base-exclusions.localhost:9000`
for an empty bundle). `composition-closure` gains three rules mirroring main's
existing 0c/0d shape — the row exists exactly once, its `serve` is `off`, and
**every one of its `entryPoints` is a negative with an empty `selectedContributors`**.
Without that last rule the row would be a way to silently force plugins *into*
every composition, which is `served-baseline`'s job and would be invisible here.

**Opting back in** is the existing protection rule, unchanged in spirit: a
composition that names the plugin explicitly — as an entry positive or a selected
contributor — wins over the inherited negative. That escape hatch is new
capability; `singularity.disabled` had none.

### 2. The negative pass closes over importers, and proves it did

`plugins/plugin-meta/plugins/closure/core/resolve-composition.ts`

`disabledClosure` is renamed `removalClosure` — it stops being "the disabling
mechanism's function" and becomes what it always was: *given that these ids leave,
what else must leave*. Its body does not change.

`expandEntrySeeds` takes the flattened **manifest** rather than just its entry
points (so it can see `selectedContributors`, and so `tsc` walks every caller), and
its negative pass becomes:

```ts
let targets = union(match(p) for negative p);
targets = targets \ (named ∪ selectedContributors);   // an explicit local positive wins
const cascade = removalClosure(targets, graph);        // ← the only new line of algorithm
for (const id of cascade) {
  if (named.has(id) || selected.has(id)) continue;     // protected — may leave a hole
  seeds.delete(id);
}
return { seeds, named, negated: targets };
```

Two rules, and the difference between them is the point:

- **Naming X suppresses the negative on X.** A composition that asks for the plugin
  gets it, and nothing cascades. This is the opt-out.
- **Naming an *importer* of X does not.** That is not a request for X, so the
  importer survives the cascade, drags X back through `hardForward`, and the
  postcondition below fires. The ambiguity is made loud rather than guessed at.

**The postcondition is the structural fix.** `resolveComposition` ends with:

```ts
const unsatisfiedExclusions = [...negated]
  .filter((t) => bundle.has(t))
  .map((t) => ({ target: t, path: explainInclusion(graph, manifest, t) }));
```

A negative that did not take effect is now a value in the result, not silence.
`explainInclusion` (`explain.ts`) already walks `hardReverse` back to the seed
frontier, so the failure names the exact import chain that re-added the plugin —
which is the repair instruction.

`Composition.unsatisfiedExclusions` is a required field on the returned type
(`closure/core/types.ts`), so it exists for every consumer rather than being an
optional nobody reads. `composition-closure` fails on a non-empty list; codegen
throws on one; Studio renders it.

**Two shapes found during implementation, both kept:**

- **`inclusion-path.ts` (new leaf).** `explainInclusion` calls `resolveComposition`,
  and `resolveComposition` now needs an explanation for `unsatisfiedExclusions` — a
  module cycle *and* an infinite recursion. The BFS moves into a leaf both sides
  call; `explainInclusion`'s public signature is unchanged. Its docstring leads with
  why it exists so nobody folds it back in.
- **`UnsatisfiedExclusion.path` is NOT nullable.** The null arm looked necessary and
  is unreachable: entries are `negated ∩ bundle`, and `bundle` is
  `hardClosure(entrySeeds ∪ selectedContributors)`, so a backward chain from the
  target to some seed provably exists and the BFS finds it. Expressing "cannot
  happen" as a nullable field is worse than either alternative, because each of the
  three consumers then invents a fallback string for a case that never fires.
  `resolveComposition` throws at the one place that can observe the contradiction
  (the bundle and the edge graph disagreeing), naming the target and the
  composition — rung 2 for the consumers, rung 4 at the origin, no dead arm.
  `explainInclusion`'s own return stays `InclusionPath | null`, where null is a real
  answer: the target is not bundled.
- **`Composition.negatedTargets: Set<PluginId>`** — the ids a negative named
  directly, after the opt-out subtraction and before the cascade. `docgen` needs it
  to tell `(excluded)` from `(excluded — cascade)`, and taking it off the same
  resolution that produces the bundle avoids a second pattern parse inside docgen.

**One call site the plan missed:** `cli/bin/commands/deploy.ts`'s `containmentOf`
calls `expandEntrySeeds`, so it takes the new manifest signature. Consequence worth
stating: its containment now also sees the base row's negatives and shrinks by the
same cascade — which keeps it agreeing with `composition-closure`'s `excludes` gate,
whose rule it deliberately mirrors, and errs permissive rather than wrongly refusing
a deploy.

### 3. Codegen filters by a bundle, and there is no unfiltered render

`plugins/framework/plugins/tooling/plugins/codegen/core/plugin-registry-gen.ts`

Today `collectEntriesWithDeps` applies two filters, one optional and one
unconditional:

```ts
const entries = (bundle ? allEntries.filter((e) => bundle.has(e.id)) : allEntries)
  .filter((e) => !disabled.has(asPluginId(e.id)));
```

After: one filter, always present.

```ts
const entries = allEntries.filter((e) => bundle.has(e.id));
```

`bundle` becomes a **required** parameter of `collectEntriesWithDeps` and
`renderCollectedDirRegistry` — rung 2: "render this registry without saying which
composition it is for" stops having a spelling, and `generatePluginRegistry` passes
`ctx.mainBundle` at the call site where the question is asked.

`RegistryGenContext` swaps `disabled: Set<string>` for two fields derived from the
same barrel-free tree it already holds:

```ts
graph: EdgeGraph;            // classifyEdges(tree), computed once
mainBundle: Set<PluginId>;   // singularity's resolved closure, base exclusions folded in
```

`disabled-ids.ts` is deleted; a `main-bundle.ts` beside it holds the read. The
`composition-closure` and `plugins-registry-in-sync` checks stop calling
`classifyEdges` themselves and take `ctx.graph`, so one more redundant classify pass
leaves every check run.

The remaining `disabled.has(id)` consumers become `!bundle.has(id)`, same file
positions: `config-origin-gen.ts` (`discoverConfigs`), `data-views-gen.ts`
(`collectDataViews`), `reorderable-slots-gen.ts` (both passes),
`slot-declaration-guard.ts`, and `config_v2/check/registrations-paired.ts`.

### 4. Reading the manifest must be fresh within one build

`buildRegistryGenContext` needs `singularity`'s manifest, and the existing read is
`readCompositionManifestsFromDisk` → `readGitLayerConfig` → the repo's
`config/plugin-meta/composition/compositions.origin.jsonc`.

That file is written by `generateConfigOrigins`, which runs in
`regenerateManifestCodegen` — *after* the registry phase. So editing the manifest in
`config.ts` would emit registries from the previous run's manifest, then regenerate
the origin, and `plugins-registry-in-sync` would fail on a build that did everything
right. Two builds to land one negative is not acceptable.

**Fix at the read:** `readGitLayerConfig` ignores an origin file whose `// @hash` no
longer matches the descriptor and falls back to `descriptor.defaults` — the same
staleness rule `nonStaleOverrideContent`
(`config_v2/core/internal/tier-logic.ts`) already applies to the user layer, applied
one layer down. A stale origin is a materialization of an older descriptor; the
descriptor is the source. Small blast radius: `readGitLayerConfig` has exactly two
callers, both checks, and `config-origins-in-sync` keeps the committed origin honest
regardless.

Verify the hash comparison is actually available at that point during
implementation; if it is not, the fallback is for codegen to read
`compositionsConfig.fields.manifests.default` directly and for both checks to go
through the same helper, so the three can never disagree.

### 5. `plugins-registry-in-sync`: identity replaces equivalence

The check's second half today proves
`render(ctx, def, mainBundle) === render(ctx, def)`. Once codegen renders *with* the
bundle, there is no second side — and the property is false the moment the base row
carries a negative, which is the point of the phase.

Delete the equivalence half. What remains is the check's original job, now strictly
stronger: the committed file must equal `render(ctx, def, ctx.mainBundle)`. "Main is
a composition" stops being proved and starts being how main is built.

Keep the good failure message. On a mismatch, diff the id set the committed file
carries against the id set the render produced and name the difference — the existing
"contains N plugin(s) outside the closure" text, now derived from the comparison
rather than from a second render.

### 6. `composition-closure`: new and adjusted rules

- **New:** the `base-exclusions` row exists exactly once, its `serve` is `off`, its
  entry points are all negatives, and its `selectedContributors` is empty.
- **New:** `unsatisfiedExclusions` must be empty for every composition, with the
  `explainInclusion` chain in the message.
- **Adjusted:** the "dead negative — trims nothing" rule now measures against the
  cascade, not the direct match. It must also be evaluated **per composition after
  flattening**, not on the base row in isolation: a base negative is legitimately
  dead for a lean composition that never reached the plugin, so deadness is only a
  failure when the negative trims nothing in *any* composition.
- **Unchanged:** `!**` is still refused, and the contradictory-negative rule still
  fires — it is now also caught downstream by the postcondition, which is the belt
  to its braces.

### 7. The flag, the tree, and the UI

- `plugins/review/plugins/plugin-changes/package.json` — drop the
  `singularity.disabled` block.
- `plugin-tree/core/internal/plugin-tree.ts` — drop `PluginNode.disabled` and the
  `pkg.singularity?.disabled` read in `collectCoreFields`. (`compositionRoot` and
  `collapsed` stay; only this key goes.)
- **New check `no-disabled-flag`** under
  `framework/tooling/plugins/checks/plugins/` — no `package.json` may carry
  `singularity.disabled`. Nothing reads the key any more, so without this a re-added
  flag is silently inert; the check turns that into a message naming the replacement
  (`!<id>.**` on the `base-exclusions` row).
- `composition/server/internal/data-handler.ts`, `core/endpoints.ts`,
  `web/internal/hooks.ts` — drop `disabledIds` from the wire and delete
  `useDisabledClosure`. The client already has the graph and the manifests and
  already runs `resolveComposition` in-browser, so main's excluded set is derived
  there like every other membership question.
- `plugin-view/core/types.ts`, `server/internal/tree-handler.ts` — drop
  `disabledSeed`.
- `studio/explorer/plugins/disabled/` → `studio/explorer/plugins/excluded/`. The
  badge asks the same question against `singularity`'s membership: a plugin the base
  row negates directly reads *Not in the app*, a cascade member reads *Not in the app
  (cascade)*. It stays separate from the `membership` tint sub-plugin, which is about
  the *draft being edited* — "what ships" and "what I am composing" are different
  questions and should not share one colour.
- `docgen.ts` — `disabledMarker` becomes `exclusionMarker`, reading `mainBundle` +
  the negated targets: `(excluded)` for a directly-negated plugin,
  `(excluded — cascade)` for one the closure took with it. Same shape, same twelve
  lines, new word.

### 8. Main's manifest is committed-source only

- `composition/web/internal/manifests.ts` — `save` refuses
  `editingId === MAIN_COMPOSITION_ID` **and `BASE_EXCLUSIONS_ID`**, mirroring the
  existing `remove` and `setServeMode` guards verbatim (including their comment
  shape: the surface renders the control inert, the throw is the loud boundary
  underneath). The base row governs every composition's registry, so it is committed
  source for the same reason main's row is.
- `studio/compositions/plugins/entry-points/web/` — both rows render their entry
  points read-only with a note pointing at
  `plugins/plugin-meta/plugins/composition/core/config.ts`.

This is not a new constraint. Turning a plugin off has always required editing
committed source and rebuilding; only the file changes.

---

## Landing order

Five commits, each independently green.

1. **`removalClosure` rename + the cascading negative pass + `unsatisfiedExclusions`**
   — closure engine only, with tests. No manifest carries a negative yet, so every
   resolved bundle is unchanged.
2. **`readGitLayerConfig` staleness fallback** — alone, so a config-layer change is
   not tangled with a codegen change.
3. **`bundle` becomes required and `ctx.mainBundle` appears — `ctx.disabled` stays.**
   Both filters run: the bundle filter is a no-op (nothing is negated yet, so
   `mainBundle` is every id) and the disabled filter still drops the twelve. Every
   generated file must be byte-identical; `git diff` on them is the test. This
   commit proves the **plumbing**.
4. **Swap the mechanism** — add the `base-exclusions` row with the one negative,
   make `flattenManifest` fold it in, drop the `package.json` flag, and delete
   `ctx.disabled` and its filter in the same commit. The two changes must land
   together: dropping either half alone puts the twelve back in the registries.
   Generated files must again be **byte-identical**, including the `(disabled)` /
   `(disabled — cascade)` wording, which is deliberately not yet touched. This
   commit proves the **semantics** — that the negative's cascade is exactly the old
   disabled closure.
5. **Rename the vocabulary and clean up** — `(excluded)` wording, the
   `no-disabled-flag` check, the wire/UI/tree field removals, the Studio badge
   rename, the write guards, `closure/CLAUDE.md` and `composition/CLAUDE.md`.

Commits 3 and 4 are the load-bearing pair: the first proves the new filter renders
what the old one did, the second proves the new *declaration* means what the old one
did. Splitting them is what makes a byte diff a usable verdict.

---

## Critical files

- `plugins/plugin-meta/plugins/closure/core/{resolve-composition,flatten-manifest,types,index,explain}.ts`
- `plugins/plugin-meta/plugins/closure/core/inclusion-path.ts` (new — the shared BFS)
- `plugins/infra/plugins/namespace/core/namespace.ts` (the reserved `base-exclusions` id)
- `plugins/framework/plugins/cli/bin/commands/deploy.ts` (`containmentOf`'s `expandEntrySeeds` call)
- `plugins/framework/plugins/tooling/plugins/codegen/core/plugin-registry-gen.ts`
- `plugins/framework/plugins/tooling/plugins/codegen/core/disabled-ids.ts` (deleted) → `main-bundle.ts`
- `plugins/framework/plugins/tooling/plugins/codegen/core/{config-origin-gen,data-views-gen,reorderable-slots-gen,slot-declaration-guard,docgen}.ts`
- `plugins/framework/plugins/tooling/plugins/checks/plugins/{plugins-registry-in-sync,composition-closure}/check/index.ts`
- `plugins/framework/plugins/tooling/plugins/checks/plugins/no-disabled-flag/` (new)
- `plugins/plugin-meta/plugins/plugin-tree/core/internal/plugin-tree.ts`
- `plugins/plugin-meta/plugins/composition/core/config.ts`, `web/internal/manifests.ts`, `server/internal/data-handler.ts`, `core/endpoints.ts`
- `plugins/plugin-meta/plugins/plugin-view/{core/types.ts,server/internal/tree-handler.ts}`
- `plugins/apps/plugins/studio/plugins/explorer/plugins/disabled/` → `.../excluded/`
- `plugins/review/plugins/plugin-changes/package.json`
- `plugins/config_v2/check/registrations-paired.ts`

## Verification

**Byte-identity (the acceptance test).** After commit 3 and again after commit 4:
`./equin build`, then `git diff --stat` on `web.generated.ts`,
`server.generated.ts`, `central.generated.ts`, `check.generated.ts`,
`data-dirs.generated.ts`, `docs/plugins-*.md` and every `CLAUDE.md`. Empty is the
pass. After commit 4 specifically, confirm the same twelve ids are still absent from
the registries and still annotated in the docs.

**Tests** (`./equin test <path>`):

- `plugins/plugin-meta/plugins/closure/core/closure.test.ts` —
  - a negative pulls out its transitive importers; a plugin the negated branch
    *depends on* stays (direction);
  - **the base row is inherited without `extends`**: a composition seeding
    `plugin-meta.facets.**` does NOT bundle `review.plugin-changes`;
  - **the opt-out works**: the same composition naming `review.plugin-changes` as an
    entry positive (and again as a `selectedContributor`) DOES bundle it, with
    `unsatisfiedExclusions` empty;
  - **naming an importer is not an opt-out**: selecting a `render-diff` adapter
    yields a non-empty `unsatisfiedExclusions` carrying the import path;
  - the real-tree `singularity` case bundles exactly `allIds` minus the twelve;
  - Phase 1's `["**", "!apps.sonata.**"]` forward guard still holds.
- `plugins/plugin-meta/plugins/composition/core/config.test.ts` — the
  `base-exclusions` row exists once, is negatives-only, `serve: "off"`; the
  `singularity` row's entry points are still exactly `["**"]`.
- `plugins/framework/plugins/tooling/plugins/codegen/core/plugin-registry-gen.test.ts`
  — a synthetic tree where `render(bundle: allIds)` equals the pre-change unfiltered
  render, and differs by exactly one entry for a bundle missing one id.

**Checks** (`./equin check`): full run green, in particular
`plugins-registry-in-sync`, `plugins-doc-in-sync`, `composition-closure`,
`config-origins-in-sync`, `config_v2:registrations-paired`, `type-check`.

**Break each new guard once** — a check never seen failing is a check not known to
work:
- Add `"!primitives.css.text.**"` to the base row (something load-bearing imports
  it) → `composition-closure` fails naming the import chain, rather than emitting a
  broken registry.
- Put a positive in the base row → refused as "the base row may only exclude".
- Re-add `singularity.disabled` to any `package.json` → `no-disabled-flag` fails and
  names the replacement.
- Edit main's or the base row's entry points in Studio → the control is inert, and
  the underlying `save` throws if reached.

**In the app.** `./equin build`, open
`http://<worktree>.localhost:9000/studio/explorer`: the twelve plugins are still
listed and now badged *Not in the app* / *Not in the app (cascade)*. Open the
`singularity` composition detail: its closure tints those twelve `excluded`, and the
review pane shows no plugin-count summary chip — the original reason the plugin was
turned off.
