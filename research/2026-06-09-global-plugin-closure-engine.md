# Plugin Closure Engine & Hard/Soft Edge Classification

**Status:** Design / ready to implement.
**Date:** 2026-06-09
**Category:** global (`plugin-meta`, `tooling`)
**Parent vision:** [`2026-06-09-global-plugin-compositions.md`](./2026-06-09-global-plugin-compositions.md)

---

## Context

The [Plugin Compositions vision](./2026-06-09-global-plugin-compositions.md) defines a **Composition** as a named, dependency-closed *selection* over the ~400-plugin space: `{ name, entryPoints, softOptOuts }`. Computing which plugins a composition actually bundles — and *why* each one is in — requires a **closure engine** that:

1. classifies every cross-plugin edge as **hard** (import — mandatory) or **soft** (slot contribution — prunable),
2. resolves the bundle as the least fixpoint of "hard-closure of entries ∪ active soft contributors",
3. assigns each plugin a **membership state** (`entry` / `required` / `contributor` / `via-contributor` / `excluded`), and
4. answers the two causality queries that carry the whole UX: *"why is X bundled?"* and *"what breaks if I prune contributor A?"*.

This is the **one load-bearing piece** of the vision — a pure library every later increment (Studio tint, composition diff, the validity check, eventual build-gating) builds on. This doc designs that engine, its edge classification, and the `composition-closure` validity check. It does **not** design the manifest registry (collected-dir) or the Studio visualization — those are the next increments, noted under *Out of scope*.

### Decisions settled with the user

- **Hard-edge source — reuse `cross-refs`, no new facet.** The original concern was that `cross-refs` was lossy (top-level-only regex, `node.name`-keyed reverse index). **This was fixed upstream in `main`** (rebased in). `cross-refs` now records every `@plugins/…` specifier and resolves it via the new nested-aware `resolvePluginSpecifier(tree, specifier)` exported from `plugin-tree/core`, yielding precise `PluginId` edges. The engine consumes this directly — **the vision's "no import-scanner to write" assumption now genuinely holds.**
- **Non-import couplings (endpoint / MCP calls) — ignore in v1.** Only **import** (hard) and **slot-contribution** (soft) edges are modeled. An endpoint caller almost always also imports the endpoint's `defineEndpoint` constant from the owner's `core/` barrel, so the dependency is already captured as a hard import. Revisit only if a real gap surfaces.
- **Unioned closure for v1.** One graph unioned across `web`/`server`/`central`; one membership answer per plugin. The per-runtime split is deferred (the underlying `cross-refs` data is per-runtime, so a later pass can split footprints without re-extracting).
- **Conservative opt-IN model (decided after first implementation — see *Findings*).** **Nothing soft is included by default.** The bundle is `hardClosure(entries ∪ selectedContributors)` — a single pass, no auto-activation, no fixpoint. Soft contributors are surfaced as a reviewable `available` frontier the human/agent recursively *selects* into the manifest. This replaced the original opt-out model (`softOptOuts`, default-included contributors), which produced a 64%-of-repo "default" bundle that opt-out couldn't restrict. No enhancement/registration slot distinction for now — keep it simple; conservative-by-default is the floor.

### Framing corrections (from design review — folded into implementation)

1. **"Dependency-closed" is a tautology, not a check.** `resolveComposition` returns a hard-closed bundle *by construction*. Under the opt-in model the check's real job shifts to surfacing **redundant selections** (a `selectedContributor` already locked in by hard edges — a no-op) and, later, **unanchored selections** (a selection that doesn't soft-contribute into the bundle). Both are advisory; closure itself can't fail.
2. **`required` dominates `contributor` in classification.** A node both hard-required by entries *and* a selected contributor is `required` (locked) — precedence `entry > required > contributor > via-contributor` is essential.
3. **Soft edges key on the slot *group symbol*.** `contribution.slot.split(".")[0]` is the PascalCase `SlotDef.groupName` (e.g. `TaskList`), matching the existing `contributions.relate()` logic — not a slot-id namespace.

---

## Inputs — all precise, all from existing facets

The engine is a **pure, browser-safe** consumer of per-node facet data already serialized into the plugin tree (`node.facets[id]`). No disk access, no barrel imports — every input below is populated by `buildPluginTree` even under `skipBarrelImport: true` (so it works at build time, at the existing `GET /api/plugin-view/tree` endpoint, and client-side in the future Studio).

| Edge | Source facet | Per-node data the engine reads |
|---|---|---|
| **Hard** `A → B` (A imports B) | `cross-refs` (`facets/plugins/cross-refs/core`) | `apiUses: Record<RuntimeFolder, { plugin: PluginId; symbol? }[]>` — forward targets. `importedBy: PluginId[]` — precomputed reverse index. **Both precise & nested-aware.** |
| **Soft** `A → B` (A contributes to a slot B owns) | `slots` (`facets/plugins/slots/core`) + `contributions` (`facets/plugins/contributions/core`) | `slots`: each node's `SlotDef[]` (`groupName`, `slotId`, `_runtimeOnly?`) → build `groupName → ownerId` map. `contributions`: `static: { slot }[]` → each node's contributed groups (`slot.split(".")[0]`). |

Reusable resolver (already exported, no factoring needed): `resolvePluginSpecifier(tree, specifier) → { node, suffix } | null` at `plugin-tree/core/internal/plugin-tree.ts:63`. The engine does **not** call it directly (cross-refs already did the resolution); it's noted as the authoritative grammar parser the inputs rely on.

---

## The engine — `plugins/plugin-meta/plugins/closure/core/`

A new pure-library sub-plugin (core-only, no web/server runtime — like `plugin-tree`). Sits alongside `plugin-tree`, `facets`, `plugin-view` under the `plugin-meta` umbrella.

### Types

```ts
export type EdgeKind = "hard" | "soft";
export interface Edge { from: PluginId; to: PluginId; kind: EdgeKind; }

/** Both directions, indexed, kind-separated. Every tree node is a key (possibly
 *  empty array) so callers never branch on undefined. `edges` is the derived
 *  flat list for explain/tests/future viz. `subtree` (node → descendant ids) is
 *  NOT a dependency edge — it is applied only at entry seeding. */
export interface EdgeGraph {
  hardForward: Map<PluginId, PluginId[]>;  // A → barrels A hard-imports
  hardReverse: Map<PluginId, PluginId[]>;  // B → who hard-imports B
  softForward: Map<PluginId, PluginId[]>;  // A → owners of groups A contributes to
  softReverse: Map<PluginId, PluginId[]>;  // B → contributors into B's owned slots
  subtree: Map<PluginId, PluginId[]>;      // node → descendant ids (containment, not a dep edge)
  edges: Edge[];
}

export interface CompositionManifest {
  name: string;
  entryPoints: PluginId[];
  /** Explicitly opted-IN soft contributors. Default [] ⇒ pure hard closure of entries. */
  selectedContributors: PluginId[];
}

export type MembershipState =
  | "entry"            // explicitly in entryPoints
  | "required"         // in hardClosure(entry seeds) — locked, NOT removable
  | "contributor"      // a SELECTED contributor that's in the bundle (not entry/required)
  | "via-contributor"  // in bundle only via a selected contributor's hard closure
  | "available"        // NOT bundled, but soft-contributes to the bundle — a reviewable option
  | "excluded";        // not bundled and not a reviewable option

export interface Composition {
  bundle: Set<PluginId>;
  membership: Map<PluginId, MembershipState>; // total: every tree node, default "excluded"
  /** Soft contributors into the bundle that aren't selected — the review frontier. */
  available: PluginId[];
  /** selectedContributors already locked in by hard edges (entry/required) — no-op selections. */
  redundantSelections: PluginId[];
}
```

### Public functions

```ts
export function classifyEdges(tree: PluginTree): EdgeGraph;
export function resolveComposition(graph: EdgeGraph, manifest: CompositionManifest): Composition;
export function resolveComposition(tree: PluginTree, manifest: CompositionManifest): Composition; // convenience: classify then resolve
export function explainInclusion(graph: EdgeGraph, manifest: CompositionManifest, target: PluginId): InclusionPath | null;
export function impactOfPruning(graph: EdgeGraph, manifest: CompositionManifest, selection: PluginId): PluginId[];   // cost of DESELECTING
export function impactOfSelecting(graph: EdgeGraph, manifest: CompositionManifest, candidate: PluginId): PluginId[]; // cost of ADDING
```

`classifyEdges` is the cached boundary (build the graph once); everything downstream takes an `EdgeGraph` so Studio can re-tint on every selection toggle and the impact queries can run two resolves without re-classifying.

**`classifyEdges(tree)`** — linear over the tree:
- *Hard:* for each node A, `hardForward[A] = unique(⋃_rt apiUses[rt].map(u => u.plugin))` minus self; invert into `hardReverse`.
- *Soft:* build `groupOwner: Map<groupName, PluginId>` from every node's `slots` facet (skip `_runtimeOnly`, first-writer-wins — mirrors `contributions.relate()`). Then for each node A, for each `static[].slot`, `owner = groupOwner.get(slot.split(".")[0])`; if `owner && owner !== A.id`, add `A → owner` to `softForward`/`softReverse`.
- *Subtree:* node → all descendant ids (containment), used only to expand umbrella entries.

**`resolveComposition`** — single pass, **no fixpoint, no auto-activation**:

```ts
function hardClosure(seeds, graph): Set<PluginId> {
  const out = new Set(); const stack = [...seeds];
  while (stack.length) {
    const x = stack.pop();
    if (out.has(x)) continue;            // visited-set ⇒ cycle/self-edge safe (DAG expected, defensive)
    out.add(x);
    for (const t of graph.hardForward.get(x) ?? []) if (!out.has(t)) stack.push(t);
  }
  return out;
}

// expandEntrySeeds: entries ∪ their subtrees (selecting an umbrella ships its subtree).
const entrySeeds = expandEntrySeeds(manifest.entryPoints, graph);
const selected   = new Set(manifest.selectedContributors);
const required   = hardClosure(entrySeeds, graph);                       // entries alone — the locked set
const bundle     = hardClosure([...entrySeeds, ...selected], graph);     // single pass; nothing soft auto-pulled
```

Classification (precedence `entry > required > contributor > via-contributor`; out-of-bundle soft contributors → `available`; default `excluded`):

```ts
const entrySet = new Set(manifest.entryPoints);
for (const node of tree.byDir.values()) membership.set(node.id, "excluded");
for (const id of bundle)
  membership.set(id,
    entrySet.has(id)  ? "entry" :
    required.has(id)  ? "required" :
    selected.has(id)  ? "contributor" : "via-contributor");

// available = soft contributors into the bundle that aren't themselves bundled.
const available = [...new Set(
  [...bundle].flatMap(b => graph.softReverse.get(b) ?? [])
)].filter(a => !bundle.has(a)).sort();
for (const a of available) membership.set(a, "available");

const redundantSelections = manifest.selectedContributors.filter(x => required.has(x) || entrySet.has(x));
```

`required` (entries alone) vs `via-contributor` (only reached via a selected contributor's hard closure) stays rigorous because `required` is a separate hard-closure set. Reviewing a composition = repeatedly resolving with a growing `selectedContributors` set; each new selection re-resolves, possibly exposing a new `available` frontier (the recursion).

**`explainInclusion(graph, manifest, target)`** → shortest "why":
```ts
export interface InclusionStep { from: PluginId; to: PluginId; kind: EdgeKind; }
export interface InclusionPath {
  target: PluginId; state: MembershipState; origin: PluginId;
  originKind: "entry" | "contributor"; steps: InclusionStep[];
}
```
If `target ∉ bundle` → `null`. Else BFS over `hardReverse` from `target` back to the seed frontier (**expanded entries ∪ selected contributors**), stop at the first seed, reverse predecessors into forward `steps`. If the seed is a selected contributor `C`, prepend the soft edge `C → owner(C)`. Prefer an entry-origin path when both exist.

**`impactOfPruning(graph, manifest, selection)`** → `bundle(with) \ bundle(with `selection` removed from `selectedContributors`)`, sorted — the cost of **deselecting** an option. Empty for an `entry`/`required` or unselected node.

**`impactOfSelecting(graph, manifest, candidate)`** → `bundle(with `candidate` added) \ bundle(without)`, sorted — the cost of **adding** an option (`candidate` plus what its hard closure newly pulls in). The review affordance. Empty if `candidate` is already bundled.

### Edge cases (handled explicitly)

| Case | Handling |
|---|---|
| Cycle in hard graph | `hardClosure` visited-set terminates. DAG expected per CLAUDE.md; defensive, not reliant. |
| Self-edge `A→A` | Dropped at `classifyEdges` (`to === from`); visited-set absorbs any leak. |
| `selectedContributor` already `required`/`entry` | No-op; node stays `required`/`entry`. Surfaced via `redundantSelections`. |
| Node both `entry` and selected | `entry` (precedence). |
| Umbrella entry (no runtime) | Ships its subtree via `expandEntrySeeds`; the runtime-bearing sub-plugin's hard closure does the rest. |
| Node with no runtime | No barrel, no edges; enters bundle only as an explicit `entry` (or its subtree). |
| Unknown `PluginId` in manifest | Inert (no edges, never bundled). The check optionally reports it as a typo. |
| Contribution to an owner-less group | No soft edge (matches existing `relate()`: `if (!owner) continue`). |

---

## Validity check — `composition-closure`

A built-in `Check` (`{ id, description, run }` from `tooling/core/types.ts`) at
`plugins/framework/plugins/tooling/plugins/checks/plugins/composition-closure/check/index.ts`
(the standard `check/index.ts` default-export pattern, auto-discovered by `./equin check`).

Closure cannot fail (the bundle is hard-closed by construction), so the check is **advisory hygiene** over declared manifests. For each `CompositionManifest`:
1. `graph = classifyEdges(tree)` (built once, reused across manifests).
2. `comp = resolveComposition(graph, manifest)`.
3. Surface, as warnings (or errors, per chosen severity):
   - **Redundant selections** — `comp.redundantSelections` (a `selectedContributor` already locked in by hard edges; the selection is a no-op).
   - **Unanchored selections** — a `selectedContributor` that is *not* a soft contributor into the bundle (it doesn't enrich anything present; likely a mistake). `explainInclusion` names how it entered.
   - **Unknown ids** — entries/selections not in the tree (typo guard).

The **capability-port-ification worklist** the vision's future work depends on is still derivable from the engine on demand: for any plugin `X` you want a composition to exclude, `{ P ∈ bundle : X ∈ hardForward(P) }` (+ `explainInclusion`) names exactly which plugins hard-import it. Under the conservative model this is a query you run against a target, not an automatic opt-out failure.

**Dependency note:** the check needs `CompositionManifest[]`. The manifest **registry** (collected-dir) is the next increment — until it lands the check iterates an empty set and trivially passes. The engine already exposes everything the check consumes (`redundantSelections`, `available`, `explainInclusion`, `hardForward`). The engine itself is verified now via a unit test against a hand-written manifest (below).

---

## Out of scope (next increments — designed in the parent vision, not here)

1. **Manifest registry** — `plugins/plugin-meta/plugins/composition/` owning `defineCollectedDir("composition")` + `loadCompositions()`. The engine defines the `CompositionManifest` *type*; the *registry* that discovers `composition/index.ts` files is Increment 2.
2. **Studio visualization** — tree tint via `Explorer.TreeRowBadge`, "why / impact" via `PluginView.Section`. The engine is built browser-safe specifically so this needs no re-architecture.
3. **Build-gating / deploy a composition; per-runtime split; cross-source composition.** Future work.

---

## Critical files

**Reuse (read first):**
- `plugins/plugin-meta/plugins/plugin-tree/core/internal/plugin-tree.ts` — `buildPluginTree`, `PluginNode`/`PluginTree`, `resolvePluginSpecifier` (`:63`), `tree.byDir`/`byPath`.
- `plugins/plugin-meta/plugins/facets/plugins/cross-refs/core/types.ts` + `facet/index.ts` — **hard edges** (`apiUses: {plugin: PluginId, symbol?}[]`, `importedBy: PluginId[]`; reworked in main, precise/nested-aware).
- `plugins/plugin-meta/plugins/facets/plugins/slots/core/types.ts` — `SlotDef` (`groupName`, `_runtimeOnly?`) for slot ownership.
- `plugins/plugin-meta/plugins/facets/plugins/contributions/core/types.ts` + `facet/index.ts:139-165` — **soft edges** (`static[].slot`); the `slotGroupToOwner` algorithm to replicate by `PluginId`.
- `plugins/plugin-meta/plugins/facets/core` — `getFacet(node, def)`.
- `plugins/framework/plugins/plugin-id/core/plugin-id.ts` — `PluginId`, `asPluginId`, `asPath`, `RuntimeFolder`.
- `plugins/framework/plugins/tooling/core/types.ts` — `Check` / `CheckResult`.

**New (to create):**
- `plugins/plugin-meta/plugins/closure/core/` — the engine: `types.ts` (Edge/EdgeGraph/CompositionManifest/MembershipState/Composition), `classify-edges.ts`, `resolve-composition.ts` (+ `hardClosure` helper), `explain.ts`, `impact.ts`, `index.ts` barrel.
- `plugins/plugin-meta/plugins/closure/core/CLAUDE.md` — hand-written prose.
- `plugins/framework/plugins/tooling/plugins/checks/plugins/composition-closure/check/index.ts` — the check (lands fully with the registry; engine-ready now).

---

## Verification

**Status: DONE — implemented and green.** `bun test plugins/plugin-meta/plugins/closure/core/closure.test.ts` (8 tests, 97 assertions) runs `buildPluginTree(PLUGINS_DIR, { skipBarrelImport: true })` + `classifyEdges` + `resolveComposition` on `{ entryPoints: ["apps.agent-manager"], selectedContributors: [] }` and asserts, against the real tree:
- default bundle is a **small fraction of the tree** (≈16% — every bundled node is `entry`/`required`, nothing soft pulled in; the exact count drifts as main grows, so the test asserts the invariant, not a magic number);
- the whole `apps.sonata.*` subtree is **out of the bundle** (`excluded`/`available`) — the conservative win;
- the `available` frontier is non-empty and contains a real soft contributor (`review`);
- selecting an `available` id pulls it in as `contributor` with a non-empty `impactOfSelecting`;
- selecting a `required` node (`shell`) appears in `redundantSelections` and changes nothing;
- `explainInclusion(shell)` is an all-hard path from the entry's runtime sub-plugin; `impactOfPruning(required) == []`.

`./equin build` succeeds and `./equin check` passes (32 checks). The `composition-closure` check + manifest registry remain deferred (next increment).

---

## Findings — why the model went conservative (opt-in)

The **first** implementation used the vision's literal opt-out model (default-included soft contributors, prune via `softOptOuts`). Run against the real tree (512 nodes) for `entryPoints: ["apps.agent-manager"]`, `softOptOuts: []`, it produced:

- **Bundle = 328/512 (64%)**: every app registers into the `Apps.App` switcher slot owned by `apps` (which is hard-`required`), and because soft contributors were included by default, **every app's subtree activated** — including 19 of `apps.sonata`'s sub-plugins (only the empty umbrella node stayed `excluded`).
- **Opt-out couldn't restrict it.** `impactOfPruning("apps.sonata.shell") = 0`; opting out all 8 other-app switcher contributors shrank the bundle by 4 nodes (328→324) — the subtree was multiply-reachable through other soft edges.

This was not an engine bug — it was the soft-edge model made measurable (exactly the engine's purpose). A single "included-by-default" soft edge conflates **enhancement** (A enriches B; default-on is right) with **registration** (A is one independent peer in a registry B hosts, e.g. apps in `Apps.App`; the registry host being bundled shouldn't drag in every peer). The mechanism can't tell them apart — only intent can.

**Decision (with the user): go conservative — opt-IN.** Nothing soft is included by default; `selectedContributors` is the explicit, recursively-reviewed opt-in set; the rest surface as the `available` frontier. This sidesteps the enhancement/registration distinction entirely (revisit per-slot policy later only if default-on richness is wanted), and makes "publish a restricted subset" the *default* posture rather than something you fight the model for. Re-run on the real tree: **bundle ≈16% of the tree** (down from 64%), `apps.sonata.*` fully out, a non-empty reviewable `available` frontier. The committed `closure.test.ts` pins this conservative behavior as an invariant (not an exact count).

## Open questions

1. **`classifyEdges` reverse-hard source** — read `cross-refs.importedBy` directly vs. invert `apiUses` ourselves. Equivalent; prefer `importedBy` (already sorted/deduped) unless we want the engine independent of that field. Minor.
2. **Multi-cause `explainInclusion`** — we return one canonical shortest path. If the UX later wants "all reasons", widen the return to `InclusionPath[]`. Not needed for v1.
