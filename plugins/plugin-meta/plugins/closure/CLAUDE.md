# closure

The **plugin closure engine** — a pure, browser-safe core-only library that
computes which plugins a *composition* bundles, and *why*. A composition is a
named, **conservative** selection over the plugin space:
`{ name, entryPoints, selectedContributors, extends? }` (`CompositionManifest`).
Sibling of `plugin-tree` / `facets` / `plugin-view` under the `plugin-meta`
umbrella; core-only like `plugin-tree` (no web/server runtime, no `definePlugin`).

## `extends` — first-class composition references (`flattenManifest`)

`extends` lists other composition NAMES (typically **packs** — reusable,
entry-less contributor sets) whose `entryPoints` + `selectedContributors` are
unioned into the host, **transitively**. `flattenManifest(manifest, registry)`
folds the chain into a single flat manifest (`extends: []`) before any
resolution: it is diamond/cycle-safe (a `visited` set over names), dedupes, and
ignores unknown references inertly — exactly mirroring how unknown plugin ids
flow inertly through `expandEntrySeeds`. **Every engine entry point
(`resolveComposition`, the causality queries, the `composition-closure` check)
operates on an already-flattened manifest** — callers flatten first; the core
never re-walks `extends`.

### The `base-exclusions` row every composition inherits

`flattenManifest` also folds in the registry row named `BASE_EXCLUSIONS_ID`
(`"base-exclusions"`, from `@plugins/infra/plugins/namespace/core`) —
**unconditionally, not via `extends`**, and skipped only when the manifest being
flattened IS that row. That is the point: an exclusion the repo has decided on
holds for compositions that do not exist yet, rather than for the rows whose
author remembered to reference it. It is the property `singularity.disabled` in a
`package.json` used to have, now spelled in the vocabulary that already decides
membership.

The row is an ordinary manifest entry — same grammar, same check, same Studio
surface — carrying **only negatives** (`composition-closure` pins
`selectedContributors: []` and every entry point starting with `!`; a positive
there would be a way to force plugins INTO every composition invisibly). It is a
legal composition id but never a servable namespace, exactly like main's.

Resolution therefore stays additive with one asymmetry, stated below: negatives
subtract, and a local positive always wins over a negative from anywhere.

**Conservative opt-IN model — NOTHING soft is included by default.** The bundle
is the hard closure of (entries ∪ explicitly selected contributors). Soft
contributors are *options* a human/agent reviews and selects; they are never
auto-activated. There is no enhancement/registration distinction, and no
fixpoint loop.

This is the one load-bearing piece of the [Plugin Compositions
vision](../../../../research/2026-06-09-global-plugin-compositions.md) — every
later increment (Studio tint, composition diff, the `composition-closure`
validity check, build-gating) builds on it. Designed in
[`research/2026-06-09-global-plugin-closure-engine.md`](../../../../research/2026-06-09-global-plugin-closure-engine.md).

## Pure & browser-safe — no disk, no barrels

Every input is read from per-node **facet data** already serialized into the
tree (`node.facets[id]`, via `getFacet`). No `fs`, no `path`, no barrel imports.
It runs identically at build time, in the `plugin-view.tree` /
`composition.data` live values' loaders, and client-side in Studio. `buildPluginTree(...,
{ skipBarrelImport: true })` populates everything the engine consumes.

The one runtime import outside this plugin is `BASE_EXCLUSIONS_ID` from
`@plugins/infra/plugins/namespace/core`, which is a zero-import leaf for exactly
this reason — build-time tooling, the CLI, the server and the browser all have to
name that row, so it lives where every runtime can reach it.

## Edge classification (`classifyEdges`)

Two edge kinds, both indexed forward + reverse:

- **hard** (mandatory, unprunable) — `A → B` when A *imports* B, read from the
  `cross-refs` facet's per-runtime `apiUses` (unioned across runtimes, self-edges
  dropped; precise & nested-aware). Importing an umbrella's barrel does **not**
  pull its children — the barrel re-exports the umbrella's own symbols.
  Also `A → B` when A *paints with a token* B's token group supplies
  (`cross-refs` `tokenUses`: a `var(--x)` or a Tailwind class compiling to one,
  resolved by [`token-usage`](../token-usage/CLAUDE.md)). Such a var exists on
  the page only once B's `web/` registers the group, and nothing imports that
  half — so without this edge a bundle silently ships the class and not the
  colour. `Edge.via` says which (`"import"` wins when both hold), so an
  inclusion path can name a token instead of a phantom import.
  Also `A → B` when B is a **companion** of A: B contributes `companion: true`
  to a slot A opened with `companions: true` (`defineSlot({ companions: true })`,
  or a capability's root slot from `defineRootSlot()`). The edge runs owner →
  contributor, the reverse of the soft contribution edge (which stays), so a
  bundle holding the owner holds its companions. It is for what a capability
  needs at runtime and cannot import, usually because the import would be a
  cycle: the sprite sheet `<Icon>` draws from (`ui.icons` ← `ui.icons.sprites`),
  the middleware every slot renders through (`primitives.slot-render` ←
  `reorder.slot-middleware`, `primitives.error-boundary`). Every OTHER
  contribution to the same slot stays an opt-in option — requiredness is per
  contribution, with the owner's consent (an unflagged slot rejects the field
  at the type level). `via` is `"companion"` (import > token > companion when
  several hold). The flag is read from the inline literal only; the
  `companions-visible` check fails on one built elsewhere.
- **soft** (prunable) — `A → B` when A *contributes* to a slot **group** B owns.
  Slot ownership comes from the `slots` facet (`groupName`, first-writer-wins,
  `_runtimeOnly` slots skipped); contributions from `contributions.static`
  (`slot.split(".")[0]` is the PascalCase group symbol). This mirrors
  `contributions.relate()` exactly, but keyed by `PluginId` (not `node.name`).

`EdgeGraph` also carries `subtree` (node → descendant ids). **Containment is NOT
a dependency edge** — it is applied only at *entry seeding*, and only when an
entry pattern explicitly opts in via `.**` (see the grammar below): entrying
`apps.agent-manager.**` ships the whole subtree, so its runtime-bearing
`…​.shell` sub-plugin is bundled without dragging in every sibling app that shares
the `apps` barrel; merely *importing* an umbrella never pulls its children (the
barrel re-exports only the umbrella's own symbols).

## Entry patterns (`entry-pattern.ts`)

`entryPoints` are **patterns**, not plain ids (`EntryPattern = string`), parsed by
`parseEntryPattern` / expanded by `matchEntryPattern`:

| Pattern | Seeds |
|---|---|
| `apps.deploy` | that node only (+ its hard closure, as always). **No implicit subtree.** |
| `apps.deploy.**` | node ∪ `subtree(node)` — opt into containment. |
| `!apps.website.demos.**` | negative — removes those ids **and their removal closure** (descendants + transitive importers) from the seed set, unless this composition names them. |
| `**` | **every plugin in the graph.** The tree has no root node, so this is the only way to spell "everything". |
| `!**` | parses, seeds nothing — refused by the `composition-closure` check (it would empty the bundle). |

`ParsedPattern` is a discriminated union — `{kind:"root"}` (no base) vs
`{kind:"id"}` — so `tsc` forces every consumer to handle the root form.
`parseEntryPattern` **never throws**: Studio renders it on user-typed strings, so
`!**` parses inertly and is refused by the *check*, not by a crash.

`expandEntrySeeds(manifest, graph)` returns `{ seeds, named, negated }`. It takes
the whole **manifest**, not just its entry points, because the negative pass has
to see `selectedContributors` too.

Positives seed their matches and record their exact base in `named`. Then the
negative pass, in three steps:

1. **Targets** — the union of every negative pattern's matches. This is what the
   author asserted must leave, and it is what comes back as `negated`.
2. **The opt-out** — subtract `named ∪ selectedContributors`. A composition that
   names X explicitly, as an entry positive *or* as a selected contributor, is
   asking for X; that request suppresses the negative on X **entirely**, so
   nothing cascades from it either. This is how a composition takes back a plugin
   the inherited base row negates.
3. **The cascade** — `removalClosure(targets, graph)`, then `seeds.delete(id)` for
   every member that is not itself protected. Removing X necessarily removes X's
   descendants and everything that transitively imports X; without this a
   surviving importer would drag X straight back through `hardClosure` and the
   negative would be silently inert.

**The two rules differ, and the difference is the point.** Naming X suppresses the
negative on X — the opt-out. Naming an *importer* of X does not: that is not a
request for X, so the importer survives the cascade, re-adds X through
`hardForward`, and the postcondition below fires. The ambiguity is made loud
rather than guessed at in either direction.

Invariants this upholds: (1) a negative can never sever a real dependency — it
prunes *seeding*, not import edges, so a protected plugin's hard-import under a
negated branch still ships (fail-loud, and now reported); (2) additivity survives
— negatives are applied *after* `flattenManifest`, and a positive from anywhere in
the flattened union shields its id, so union-of-compositions stays a pure union;
(3) **root names nothing** — a positive `**` seeds every id but adds none to
`named`. If it named everything, no negative could ever trim (every id would be
protected) and `composition-closure` would reject `**` + `!x.**` as a dead
negative. Root means "everything is in", not "everything is explicitly demanded".
Consequences under `**`, all correct: no node classifies `entry`, every bundled
node is `required`, `available` is empty, and any `selectedContributors` entry is
redundant. Unknown bases pass inertly, as before.

`removalClosure(seeds, graph)` — the reverse+subtree fixpoint (`subtree` ∪
`hardReverse`) — is the general statement *given that these ids leave, what else
must leave*, not any one mechanism's function. It is the mirror of `hardClosure`,
which walks `hardForward` (what a plugin needs).

## Resolution (`resolveComposition`)

Single pass, **no fixpoint loop, no auto-activation**:

```
{ seeds, named, negated } = expandEntrySeeds(manifest)   // patterns → seeds, named bases, negated targets
required                  = hardClosure(seeds)           // entries alone — the locked set
bundle                    = hardClosure(seeds ∪ selectedContributors)
negatedTargets            = negated                       // what was asserted
unsatisfiedExclusions     = negated ∩ bundle             // the postcondition
```

Membership `entry` is the `named` set (the positive pattern bases); a `.**` base
is `entry`, its implicitly-seeded descendants are `required`.

With the default `selectedContributors: []`, `bundle === required` — a small,
purely-hard bundle. Reviewing a composition means recursively *selecting* options
from the `available` frontier; each selection re-resolves, adding the selected
contributor and its hard closure.

`available = { A : A ∉ bundle, and A soft-contributes to some B ∈ bundle }` —
the reviewable option frontier (`softReverse` over the bundle, minus bundle
members; sorted + deduped). These nodes carry membership `available`.

**Membership** (total over every tree node; in-bundle precedence
`entry > required > contributor > via-contributor`, default `excluded`):

| state | meaning |
|---|---|
| `entry` | explicitly in `entryPoints` |
| `required` | in `hardClosure(entrySeeds)` — locked, not removable |
| `contributor` | a SELECTED contributor that's in the bundle (not entry/required) |
| `via-contributor` | bundled only via a selected contributor's hard closure |
| `available` | NOT bundled, but soft-contributes to the bundle — a reviewable option |
| `excluded` | not bundled and not a reviewable option |

`redundantSelections = selectedContributors ∩ (required ∪ entries)` — a selection
already locked in by hard edges, so it's a no-op worth surfacing in review.

### `negatedTargets` vs the cascade

`Composition.negatedTargets` is the set a negative named DIRECTLY — after the
opt-out subtraction, before the cascade. It is what the author asserted; the ids
that left with it are what the assertion cost. That distinction is the one a
reader needs, and it is why docgen can mark `(excluded)` against a deliberately
excluded plugin and `(excluded — cascade)` against one that only left because
something else did — reading both off the same resolution that produced `bundle`,
with no second pattern parse anywhere.

### `unsatisfiedExclusions` — the postcondition

A **required** field on `Composition` (required, not optional: an optional field
is one nobody reads). Each entry is `{ target, path }` — a negated id that is in
the bundle anyway, plus the shortest import chain that re-added it, same shape
`explainInclusion` returns. **Non-empty means the composition does not mean what
its manifest says**, and the path is the repair instruction.

It can only be non-empty via the asymmetry above: a protected node (an explicitly
named positive or selected contributor) that imports a negated target survives the
cascade and drags the target back. `composition-closure` fails on a non-empty
list, codegen throws on one, and Studio renders it — so a negative that did not
take effect is a value in the result rather than silence.

## Causality queries

- `explainInclusion(graph, manifest, target)` → shortest "why bundled": BFS over
  `hardReverse` from `target` back to the seed frontier (expanded entries ∪
  selected contributors), entry-origin preferred. A selected-contributor origin
  prepends its soft edge. `null` if `target` is not bundled.

  The BFS itself lives in `inclusion-path.ts` as `inclusionPathWithin(graph, ctx,
  target)`, taking the ALREADY-RESOLVED parts (`bundle`, `membership`,
  `entrySeeds`, `selectedContributors`). `explainInclusion` is the manifest-shaped
  wrapper that resolves and delegates; `resolveComposition` calls the same leaf
  directly for `unsatisfiedExclusions`. Without that split the two would import
  each other — a module cycle, and an infinite recursion — or there would be two
  copies of the BFS.
- `impactOfPruning(graph, manifest, selection)` → `bundle(with) \ bundle(with
  `selection` deselected)`, sorted — the cost of DESELECTING an option. Empty for a
  hard-locked (`entry`/`required`) or unselected node — deselecting drops nothing.
- `impactOfSelecting(graph, manifest, candidate)` → `bundle(with `candidate`
  selected) \ bundle(without)`, sorted — the cost of ADDING an option: `candidate`
  plus everything its hard closure newly pulls in. The review affordance. Empty if
  `candidate` is already bundled.

## Out of scope (deferred increments)

- The `composition-closure` **check** and the **manifest registry**
  (`defineCollectedDir("composition")`). The engine defines the
  `CompositionManifest` *type* (its input); the registry that discovers manifests
  is the next increment. Until then the check would iterate an empty set.
- Studio visualization; per-runtime split (the unioned graph is v1).

## Tests

`core/closure.test.ts` runs `buildPluginTree` + `classifyEdges` +
`resolveComposition` against the **real** tree for the `agent-manager`
composition. Under the conservative model: the default bundle is small (16/512 —
hard closure of the entries alone), `shell` is `required`, the whole
`apps.sonata.*` subtree is OUT of the bundle (`excluded`/`available`), the
`available` frontier is non-empty (57 options), selecting an `available` id
(`review`) pulls it in as `contributor` with a non-empty `impactOfSelecting`,
selecting a `required` node surfaces in `redundantSelections`, plus total
membership, an all-hard `explainInclusion` path, and `impactOfPruning(required)`
empty.

The exclusion half is pinned there too: the cascade's DIRECTION (importers go, a
dependency of the negated branch stays); the base row inherited with no `extends`
(a composition seeding only `plugin-meta.facets.**` does not bundle
`review.plugin-changes`); the opt-out in both spellings (entry positive, selected
contributor) bundling it back with `unsatisfiedExclusions` empty; naming an
*importer* NOT being an opt-out (a selected `render-diff` adapter yields a
non-empty `unsatisfiedExclusions` carrying the import path); and the migration
itself — real-tree `singularity` (`["**"]` + the inherited base row) bundling
exactly every plugin minus the twelve `singularity.disabled` used to remove.

Run with `./singularity test plugins/plugin-meta/plugins/closure`.

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./singularity build` -->

## Plugin reference

- Core:
  - Uses:
    - `framework/plugin-id.asPluginId`
    - `framework/plugin-id.PluginId`
    - `framework/plugin-id.SHIPPED_RUNTIME_FOLDERS`
    - `infra/namespace.BASE_EXCLUSIONS_ID`
    - `plugin-meta/facets.getFacet`
    - `plugin-meta/facets/contributions.contributionsFacetDef`
    - `plugin-meta/facets/cross-refs.crossRefsFacetDef`
    - `plugin-meta/facets/slots.slotsFacetDef`
  - Exports (types):
    - `Composition`
    - `CompositionManifest`
    - `Edge`
    - `EdgeGraph`
    - `EdgeKind`
    - `EntryPattern`
    - `HardEdgeVia`
    - `InclusionPath`
    - `InclusionStep`
    - `MembershipState`
    - `ParsedPattern`
    - `SerializedEdgeGraph`
    - `UnsatisfiedExclusion`
  - Exports (values):
    - `classifyEdges`
    - `deserializeEdgeGraph`
    - `expandEntrySeeds`
    - `explainInclusion`
    - `flattenManifest`
    - `hardClosure`
    - `impactOfPruning`
    - `impactOfSelecting`
    - `matchEntryPattern`
    - `parseEntryPattern`
    - `removalClosure`
    - `resolveComposition`
    - `serializeEdgeGraph`
- Cross-plugin:
  - Uses tokens: `ui/tokens/shape --spacing`
  - Imported by:
    - `framework/tooling/codegen`
    - `plugin-meta/plugin-refs`

<!-- AUTOGENERATED:END -->
