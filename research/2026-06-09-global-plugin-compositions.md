# Plugin Compositions — a view primitive over the plugin space

**Status:** Vision / preliminary design. Scope intentionally narrowed to the *abstraction* and its *visualization*. Capability-dropping, build/deploy, and multi-repo composition are named as future work, not designed here.

**Date:** 2026-06-09
**Category:** global (touches `plugin-meta`, `tooling`, `studio`)

---

## Context

The repo is a single monorepo of ~400 plugins, and today a plugin's **logical identity is its physical location** — there is exactly one tree, and every plugin discovered on disk is bundled. That doesn't scale past one user or one product:

- A user should be able to keep **custom plugins in their own repo** and have agents see them merged into the core tree as one unified surface.
- **Publishing an app** should mean shipping a *restricted, dependency-closed subset* of plugins, deployable on its own.
- The **same repo** should yield **multiple flavors** of the same app — e.g. with or without the self-improvement machinery — as different *projections*, not different repos.

The unifying primitive behind all three is a **Composition**: a named, dependency-closed *selection* over the plugin space that composes (unions) with other compositions. There is no privileged "platform" tier — the framework is just plugins a composition may or may not include; "the platform" is simply a composition others build on.

This doc defines the Composition abstraction and the visualization that makes "what gets bundled, and why" legible. It deliberately stops short of the refactors needed to actually *drop* capabilities (DB, conversations, CLI) — that is future work that the foundation here makes tractable and even drives.

### Decisions already settled (from design discussion)

- **Override is forbidden.** A composition can only *add* plugins / keep-or-prune optional contributors — never replace a core plugin's file. This keeps composition a clean union with no precedence rules.
- **Capabilities are out of scope for now.** The eventual answer (e.g. `database` becomes a generic interface + `postgres`/`noop` provider slots, so dropping a provider drops the feature with a clean DAG) is just the existing collection-consumer rule applied to a capability. Not designed here.
- **Single primitive, two axes.** *Projection* (one repo → many compositions) and *cross-source composition* (many repos → one tree) are the same selection/union algebra. Only projection is in near-term scope; cross-source is future work.

---

## The abstraction

> A **Composition** = a named, declarative, dependency-closed selection over the plugin space:
> `{ name, entryPoints: PluginId[], softOptOuts: PluginId[] }`.

Two edge kinds over the plugin graph drive everything:

- **Hard edge** `A → B`: `A` imports from `B`'s runtime barrel. Following hard edges is *mandatory* — if `A` is in the bundle, `B` must be too.
- **Soft edge** `A → B`: `A` contributes to a slot **owned by** `B`. Soft contributors are *optional* — `B` works without `A`. They default to included and can be pruned via `softOptOuts`.

### Membership = a fixpoint

The bundle for a composition is the least fixpoint of:

```
bundle = hardClosure( entryPoints ∪ activeContributors(bundle) )

activeContributors(bundle) = { A : A soft-contributes to some B ∈ bundle,  A ∉ softOptOuts }
hardClosure(S)            = S plus everything reachable from S over hard edges
```

It converges (monotone, bounded by the plugin set). Each node then classifies into a **membership state** — the basis for the tree tint and the "why":

| State | Meaning | Prunable? |
|---|---|---|
| `entry` | explicitly selected entry point | n/a (remove the entry) |
| `required` | in `hardClosure(entryPoints)` — pulled by hard edges alone | **no** (locked) |
| `contributor` | active soft contributor into a bundled slot | **yes** (opt out) |
| `via-contributor` | in the bundle only through some active contributor's hard closure | yes (transitively, by opting out its contributor) |
| `excluded` | not in the bundle | — |

Two causality queries fall directly out of this and carry the whole UX:

- **"Why is X bundled?"** — a path over hard edges from an entry (or from an active contributor) to X.
- **"What breaks if I prune contributor A?"** — `bundle(with A) \ bundle(without A)`.

> Refinement (not v1): closure is genuinely **per-runtime** — a plugin's `web` closure ≠ its `server` closure. v1 unions across runtimes for one "is it in the bundle" answer; a later pass can split web/server footprints.

### What's expressible *today*, with zero refactoring

Because soft contributors are prunable for free, the **with/without self-improvement** flavor is already achievable: the self-improvement plugins (`improve`, `review`, `crashes`, `build`, …) are slot contributors, so a composition that lists them in `softOptOuts` produces a working app without them. This is the anchor demo — it proves the abstraction end-to-end without touching a single capability.

---

## Foundation: the closure engine (the one load-bearing piece)

A pure library over the existing plugin graph. **No import-scanner to write** — it consumes facets that already exist.

**Home:** `plugins/plugin-meta/plugins/closure/core/` (alongside `plugin-tree`, `facets` — "plugins about the plugin system itself").

**Inputs (all public today):**

- `buildPluginTree(pluginsRoot)` → `PluginTree` with `byDir`/`roots` and per-node `facets`.
  `plugins/plugin-meta/plugins/plugin-tree/core` (`internal/plugin-tree.ts:227`).
- **Hard edges** — `cross-refs` facet: `getFacet(node, crossRefsFacetDef)` → `{ apiUses: Record<Runtime,string[]>, importedBy: string[] }`.
  `plugins/plugin-meta/plugins/facets/plugins/cross-refs/core/types.ts`. `apiUses` entries are `"otherPlugin.Symbol"` (forward); `importedBy` is the precomputed reverse index.
- **Soft edges** — `contributions` facet: `getFacet(node, contributionsFacetDef)` → `{ static, runtime, slotContributors }`. `slotContributors` is the precomputed reverse index of "who contributes to my slots"; `static[].slot` + the `slots` facet's `groupName → owner` map give the forward direction.
  `plugins/plugin-meta/plugins/facets/plugins/contributions/core/types.ts`, `.../slots/core/types.ts`.
- `detectCycle` reusable from `@plugins/framework/plugins/tooling/plugins/boundaries/core` if needed for validation.

**Outputs (the reusable API):**

- `classifyEdges(tree)` → `{ hard: Edge[], soft: Edge[] }` over `PluginId`s.
- `resolveComposition(tree, manifest)` → `{ membership: Map<PluginId, MembershipState>, bundle: Set<PluginId> }`.
- `explainInclusion(tree, manifest, target)` → hard-edge path(s) to `target`.
- `impactOfPruning(tree, manifest, contributor)` → `PluginId[]` removed.

**Validity check (gatekeeper + worklist).** A new built-in `Check` at `plugins/framework/plugins/tooling/plugins/checks/plugins/composition-closure/check/index.ts` (the standard `check/index.ts` default-export pattern; `Check` = `{ id, description, run }` from `tooling/core/types.ts`). It validates every declared composition is dependency-closed and surfaces, for a composition that opts out a capability it still hard-depends on, *exactly which plugin* hard-imports it — i.e. the report doubles as the future port-ification worklist.

---

## Manifests: named compositions via collected-dir

Compositions are **declarative static specs in the repo**, many per repo — the exact shape of the **collected-dir** pattern (not config_v2, which is a per-user/override settings system; shape mismatch is fundamental).

- New plugin `plugins/plugin-meta/plugins/composition/` owns `defineCollectedDir("composition")` in its `core/` (mirrors `checkCollectedDir`, `facetCollectedDir`).
  `plugins/framework/plugins/tooling/plugins/collected-dir/core/define.ts:17`.
- Each composition is a `<plugin>/composition/index.ts` default-exporting a `CompositionManifest` (`{ name, entryPoints, softOptOuts }`, ids built via `asPluginId(...)` from `@plugins/framework/plugins/plugin-id/core`).
- `loadCompositions()` = `loadCollectedDir<CompositionManifest>(compositionEntries, { isItem, dedupeKey: m => m.name })`. Codegen auto-discovers every `composition/index.ts` and emits `composition.generated.ts` on `./equin build` — no central registry to edit.

This is purely additive: defining compositions changes nothing about what builds today (the web/server registries remain filesystem-derived and complete). Gating the actual build on a composition is **future work** — it would filter the generated `web.generated.ts`/`server.generated.ts`, or gate contributions at runtime.

---

## Visualization (the deliverable), in three standalone increments

All inside the existing **Studio** app; reuse, don't invent.

### Increment 1 — Closure visualization, read-only (the foundation, useful alone)

Pick any entry point → see its closure tinted on the plugin tree + the hard/soft classification. No manifest, no persistence, no build hook. Valuable on its own as "understand what this app actually drags in."

- **Tree tint** via the existing additive slot `Explorer.TreeRowBadge` (`plugins/apps/plugins/studio/plugins/explorer/web/slots.ts:11`), contributed from a new sub-plugin `studio/plugins/explorer/plugins/membership/`. Each badge component gets `{ node: PluginNode }` and reads the active selection from context. A colored chip needs zero changes to `TreeRow`; a full-row background band can be an `absolute inset-0 -z-10` element emitted from the badge (avoids touching `TreeRow` at `plugin-tree.tsx:172`).
- **"Why included" / "impact of pruning"** rendered in the `plugin-view` detail pane via a new `PluginView.Section` (`plugins/plugin-meta/plugins/plugin-view/web/slots.ts:3`), reusing `explainInclusion` / `impactOfPruning`.

### Increment 2 — Named compositions

Persist selections as collected-dir manifests (above); a new Studio sidebar pane lists compositions and drives the active selection the tint reads. New pane follows the `explorer` pattern exactly: `Pane.define` + `Pane.Register` + `Studio.Sidebar` (`studio/plugins/shell/web/slots.ts:5`). Editing (toggling soft opt-outs, adding entries) writes the manifest; the closure recomputes live (invalid/required nodes are locked by the engine, so you can only express closed selections).

### Increment 3 — Composition diff + closure graph

- **Diff** two compositions → symmetric difference tinted on the tree + a feature-level delta. This is where "with vs without self-improvement" becomes visible.
- **Closure graph** canvas — the DAG with entries highlighted and hard/soft edges styled differently. **Greenfield**: no graph renderer exists in the repo today (no d3/reactflow/cytoscape/dagre). Scope a focused subgraph around a selected node rather than rendering all ~400 nodes. Both tree-tinted and graph canvases are wanted; they are separate sub-tasks, not decided here.

---

## Explicitly out of scope (future work)

1. **Capability ports** — restructuring `database`/`conversations`/`cli` into generic-interface + provider-slot so they can be dropped. The closure check's report is the worklist for this.
2. **Build/deploy a composition** — making `./equin build`/publish target a composition and deploy that flavor to its own namespace.
3. **Cross-source composition** — merging a user's custom-plugin repo with core (the multi-repo axis + write-routing/manifest). Same union algebra, plus a source-root + git layer.

---

## Critical files

**Reuse (read these first):**
- `plugins/plugin-meta/plugins/plugin-tree/core/internal/plugin-tree.ts:227` — `buildPluginTree`, `PluginNode`/`PluginTree`.
- `plugins/plugin-meta/plugins/facets/plugins/cross-refs/core/types.ts` — hard-edge facet (`apiUses`/`importedBy`).
- `plugins/plugin-meta/plugins/facets/plugins/contributions/core/types.ts` + `.../slots/core/types.ts` — soft-edge facet (`slotContributors`, `static[].slot`, slot ownership).
- `plugins/framework/plugins/tooling/plugins/collected-dir/core/{define.ts,load-collected-dir.ts}` — manifest registry pattern.
- `plugins/framework/plugins/plugin-id/core/plugin-id.ts` — `PluginId`, `asPluginId`.
- `plugins/apps/plugins/studio/plugins/explorer/web/{slots.ts,components/plugin-tree.tsx}` — tree + `TreeRowBadge` slot.
- `plugins/plugin-meta/plugins/plugin-view/web/slots.ts` — `PluginView.Section` slot.
- `plugins/apps/plugins/studio/plugins/shell/web/slots.ts` — `Studio.Sidebar`/`Toolbar`; `explorer/web/index.ts` + `panes.tsx` as the new-pane template.
- `plugins/framework/plugins/tooling/core/types.ts` — `Check` interface.

**New (to create):**
- `plugins/plugin-meta/plugins/closure/core/` — closure engine (pure lib).
- `plugins/plugin-meta/plugins/composition/core/` — `CompositionManifest` type + `defineCollectedDir("composition")` + `loadCompositions()`.
- `plugins/framework/plugins/tooling/plugins/checks/plugins/composition-closure/check/index.ts` — validity check.
- `plugins/apps/plugins/studio/plugins/explorer/plugins/membership/` — tree tint badge.
- `plugins/plugin-meta/plugins/plugin-view/plugins/inclusion/` (or a `plugin-view` section sub-plugin) — "why / impact" section.
- `plugins/apps/plugins/studio/plugins/compositions/` — sidebar pane + composition list/editor (Increment 2+).

---

## Verification

- **Engine (unit-level, no UI):** a script/test that runs `buildPluginTree` + `resolveComposition` on a hand-written manifest with `entryPoints: ["apps.agent-manager"]` and asserts the bundle excludes `apps.sonata`, includes `shell`/`live-state` as `required`, and that opting out the self-improvement plugins removes them and only them (via `impactOfPruning`).
- **Check:** `./equin check composition-closure` passes for a closed composition and fails with a precise "X hard-imports Y" message for a deliberately broken one.
- **Visualization (Increment 1):** `./equin build`, then open `http://<worktree>.localhost:9000` → Studio → Explorer; select an entry point and confirm the tree tints by membership state and the detail pane shows the "why included" hard-edge path. Verify with `bun e2e/screenshot.mjs` (click the entry, capture before/after).
- **Anchor demo (Increment 2/3):** two compositions of `apps.agent-manager` — one full, one with self-improvement opted out — and confirm the diff view shows exactly the self-improvement subtree as the delta.

---

## Open questions

1. **Name.** "Composition" is used throughout (avoids collision with the existing `plugin-view` detail-pane plugin and matches the project's own "agents compose apps" language). Alternatives: *view*, *lens*, *slice*. Worth locking before code.
2. **Soft-edge precision.** Slot contributions are the clear soft-edge source; are there other optional couplings (e.g. dynamic/endpoint calls) that should also be soft rather than hard? The `contributions` facet covers slots; endpoint/MCP calls are currently hard imports.
3. **Per-runtime vs unioned closure** for v1 — union is simpler and proposed; confirm that's acceptable before the engine hardens its API.
