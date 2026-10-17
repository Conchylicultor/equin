# composition-closure

Validity gate for every declared composition (`./singularity check
composition-closure`). Reads the committed git-layer `compositions` config_v2
manifests straight off disk via `readCompositionManifestsFromDisk(root)` (codegen
core — no server runtime, strict `// @hash` header contract, falls back to the
seeded defaults on a fresh checkout). The same helper backs
`plugins-registry-in-sync`, so the two checks can never disagree about what the
repo declares. The plugin tree comes from `buildRegistryGenContext(root)`, whose
memoized barrel-free faceted tree is shared with every other check in the run.

For each composition it enforces: unique `name`, unique `id`, every
entry/contributor id resolves to a real plugin, every `extends` reference
resolves to a real composition name, no redundant selections (already locked by
the entries' hard closure), every selected contributor is a genuine
**load-bearing soft option** (deselecting it removes it from the bundle), and
every `excludes` bundle stays **disjoint** from the composition's hard closure.
Fails loudly naming the composition and offending id.

## The main app's own row

`singularity` (`MAIN_COMPOSITION_ID`) is an ordinary entry in the manifest whose
entry points are the root pattern `["**"]` — every plugin. Two manifest-SHAPE
rules protect it: it must be present **exactly once** (the id is a namespace, and
`plugins-registry-in-sync` finds "the main composition" by that id to prove its
closure renders the committed registries byte-for-byte), and it must carry
`serve: "off"`. Main is built and served by the build command into the main
checkout's own namespace, never as a served composition — `activatedCompositionIds`
already filters on servability, so a stored mode is inert; this rule is about
the committed seed telling the truth, not about preventing an effect.

Ids are checked for uniqueness because they are now load-bearing: an id is the
gateway namespace, the per-composition registry file segment, the spec dir, the
DB name and the Studio detail route.

## `excludes` — the self-containment guard

`excludes` is the **dual of `extends`**: a list of composition NAMES whose
plugins this composition's bundle must NOT contain. An app declares it is
self-contained (releasable standalone) by excluding the infra bundles it must
stay free of — e.g. Sonata excludes `["agent-runtime", "auth"]`. `auth` is a
separate bundle so it is forbidden **on demand**.

For each composition with a non-empty `excludes`, the check computes its resolved
hard-closure `bundle` and, for each named bundle, that bundle's **containment** —
its (flattened) entries + contributors plus each one's `subtree`, but NOT their
hard deps. If `bundle ∩ containment ≠ ∅` it fails, naming the offending
plugin(s) and printing the `explainInclusion` path that pulls the first one in.

Using *containment* (not the excluded bundle's own hard closure) keeps generic
shared infra (`database`, `jobs`, …) usable by apps while still catching
transitive contamination: the deep taproots (`infra.worktree`,
`infra.git-watcher`, `infra.claude-cli`) are listed as the `agent-runtime`
bundle's entries, so any app whose hard closure reaches one surfaces it in the
bundle, where it intersects the containment. New agent-runtime infra is caught
automatically once it depends on a listed taproot; a brand-new top-level
agent-runtime root is added to the `agent-runtime` bundle's `entryPoints` (a
config edit, like any composition).

**Packs vs. flattening.** A composition with **no entry points** is a pure
contributor SET (a pack) — it carries no bundle context, so the redundant /
soft-option checks are skipped for it (only id + `extends`-name resolution
apply); its contributors are validated where an app `extends` it. Every
composition WITH entry points is validated against its **flattened** manifest
(`flattenManifest(m, allManifests)` — own + extended packs' entries/contributors
unioned), so a profile's `extends` packs are checked in the app's real bundle.

Under the conservative opt-in model dependency-closedness is automatic
(`resolveComposition` always returns a hard-closed bundle), so this check is a
*validity* gate, not a closure repair — the historical name is kept for
continuity with the Plugin Compositions vision.

## `home` — the app that owns `/`

Every DEPLOYED composition (an `app` / `profile` row, or any served row)
declares `home`, a `defineApp` id; a subsystem lens may leave it empty, but a
home anyone sets must resolve (via `resolveCompositionHome`, `plugin-meta/composition/core`)
against the apps its resolved bundle holds — apps are read statically by
codegen's `readDeclaredApps`. It fails when the bundle holds apps but `home` is
empty, when `home` names no app, when the named app's shell is not bundled, and
when a home is declared for a bundle with no app. A pack (no entry points) must
leave it empty. Registry codegen resolves the same verdict and throws on it, so
the web registry's `composition.home` (the `/` redirect target) is always one of
the composition's own apps — never load order.

## The global exclusions row

`base-exclusions` (`BASE_EXCLUSIONS_ID`) is the one row that says what is in NO
app. `flattenManifest` folds it into **every** manifest unconditionally — not via
`extends` — so an exclusion written once holds for compositions that do not exist
yet. Three shape rules mirror main's: present **exactly once**, `serve: "off"`,
and **negatives only** — every entry point starts with `!` and
`selectedContributors` is empty. That last one is the load-bearing rule: a
positive on a row folded into everything would silently force a plugin into every
bundle in the repo, which is `served-baseline`'s job and is done there through
`extends`, visibly, on the row that opted in.

A composition takes an excluded plugin back by **naming** it — as an entry
positive or a selected contributor — which suppresses the inherited negative
outright.

## Exclusions must actually take effect

A negative removes its targets *and their removal closure* (descendants +
transitive importers) from the seed set, but never an id the composition names.
So a named plugin that IMPORTS an excluded one survives and drags the excluded
plugin back through the hard closure. The engine reports that as
`Composition.unsatisfiedExclusions` rather than guessing which of the two the
author meant, and this check **fails on a non-empty list**, printing the import
chain — which is the repair instruction: exclude the importer at the head of the
chain too, or drop the exclusion.

## Dead negatives are judged across ALL compositions

A negative that trims nothing is a typo or a stale leftover — but only if it
trims nothing **anywhere**. Since `base-exclusions` is inherited by lean
compositions that never reached the excluded plugin, trimming nothing *there* is
the correct outcome. So the rule accumulates per pattern text across every
composition and fails only when no composition trimmed anything, naming the rows
that authored the pattern.

"Trims" is measured against the **cascade** (`removalClosure`), not the direct
pattern match, exactly as the engine measures it: a negative whose entire effect
is on importers of its target is live, not dead.

## `companions-visible` — a companion the engine cannot read

The second check in this folder. The engine bundles a companion
(`companion: true` on a contribution to a slot opened with `companions: true`;
see [`closure`](../../../../../../../plugin-meta/plugins/closure/CLAUDE.md)) from
the STATIC parse of a barrel's inline `contributions: [ … ]` literal. A
companion built anywhere else is real at runtime and invisible to the engine, so
it would ship as an opt-in option and drop out of every bundle that does not
select it. The check imports each web barrel and fails when its runtime
companion count differs from what the static parse read. A barrel whose
`contributions` is a live array cannot host a companion: give it its own
sub-plugin (`reorder/plugins/slot-middleware`).

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./singularity build` -->

## Plugin reference


<!-- AUTOGENERATED:END -->
