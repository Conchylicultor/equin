# Plugin Compositions — Studio visualization

**Status:** Plan / ready to implement. **Date:** 2026-06-15. **Category:** global (`apps/studio`, `plugin-meta/composition`, `plugin-meta/closure`, `plugin-meta/plugin-view`).

## Context

The [Plugin Compositions vision](./2026-06-09-global-plugin-compositions.md) introduces a **Composition** — a named, dependency-closed selection over the ~500-plugin space — to make "what gets bundled, and why" legible. The load-bearing pieces are **already built and merged**:

- **Closure engine** — `plugins/plugin-meta/plugins/closure/core` (pure, browser-safe). Exports `classifyEdges`, `resolveComposition`, `explainInclusion`, `impactOfPruning`, `impactOfSelecting`, `hardClosure` + types (`EdgeGraph`, `CompositionManifest`, `MembershipState`, `Composition`, `InclusionPath`).
- **Manifest registry** — `plugins/plugin-meta/plugins/composition/core` (`loadCompositions()`, `defineCollectedDir("composition")`, build-generated registry).
- **Validity check** — `composition-closure` (`./equin check composition-closure`).
- **Two anchor manifests** — `plugins/apps/plugins/agent-manager/composition/index.ts` defines `agent-manager` (full) and `agent-manager-lean` (no self-improvement). They differ by exactly `improve.element-picker, review, reports.crash, reports.launch-fix, screenshot.draw-on-app` — the with/without-self-improvement anchor demo.

**What's missing is the visualization** — nothing in Studio references composition/closure/membership today. This plan builds it in three standalone increments.

`CompositionManifest` = `{ name, entryPoints: PluginId[], selectedContributors: PluginId[] }` — a **conservative opt-IN** model. Default bundle = pure hard closure of the entries; soft contributors are reviewed and explicitly selected. `MembershipState` ∈ `entry | required | contributor | via-contributor | available | excluded`.

### Settled decisions (from review)

- **Tint:** full-row background band, colored by membership state.
- **Closure root (Inc 1):** a "pin as root" affordance (distinct from the inspected node).
- **Persistence (Inc 2):** draft-only — live in-memory editing, no disk writes this round.
- **Inc 3:** ship the composition **diff** now; the greenfield closure-graph **canvas** becomes a filed follow-up task.

## Architecture: client-side engine over a server-shipped `EdgeGraph`

Key enabler (confirmed in `closure/CLAUDE.md`): the engine consumes **only** facet data populated under `buildPluginTree(..., { skipBarrelImport: true })` — `cross-refs.apiUses`, `slots.groupName`, `contributions.static` — and `resolveComposition`/`explainInclusion`/`impact*` all operate on the **serializable `EdgeGraph`**, not the raw tree. Only `classifyEdges` needs the (Node-only) `PluginTree`.

So: **the server classifies the graph once and ships it; the client runs resolve/explain/impact reactively, fully client-side.** No per-interaction round-trips → instant live editing and diffing.

```
server (once, cached)                     client (reactive, pure)
buildPluginTree(skipBarrelImport)   ──►   deserializeEdgeGraph
  → classifyEdges → serialize             resolveComposition(graph, draftManifest)
loadCompositions()                  ──►   explainInclusion / impact*  on the EdgeGraph
```

Compositions must come from the server anyway (`loadCompositions` is bundler-opaque), so one endpoint carries both the graph and the manifests.

## Shared infrastructure (prerequisite for all increments)

**1. Serialize the graph** — `plugins/plugin-meta/plugins/closure/core/serialize.ts` (+ barrel export). `serializeEdgeGraph(graph): SerializedEdgeGraph` (Maps → records/arrays) and `deserializeEdgeGraph(s): EdgeGraph`. Pure; closure stays core-only.

**2. Endpoint contract** — `plugins/plugin-meta/plugins/composition/core/endpoints.ts`. `defineEndpoint` `GET /api/composition/data` → `{ graph: SerializedEdgeGraph, manifests: CompositionManifest[], allIds: PluginId[] }`. Export from `composition/core` barrel. (Reuse `defineEndpoint` from `@plugins/infra/plugins/endpoints/core`.)

**3. Server impl** — NEW `plugins/plugin-meta/plugins/composition/server/index.ts` (`definePlugin`, single default export). `implement(getCompositionData, …)`: lazily build + **module-cache** `buildPluginTree(join(REPO_ROOT,"plugins"),{skipBarrelImport:true})` → `classifyEdges` → `serializeEdgeGraph`; `loadCompositions()`; return. Mirrors the `composition-closure` check (`…/composition-closure/check/index.ts`) exactly. Tree build is expensive → build once per process (acceptable for an introspection tool; note as a follow-up if staleness matters).

**4. Web hooks + active-composition store** — NEW `plugins/plugin-meta/plugins/composition/web/index.ts` (`definePlugin`):
- `useCompositionData()` — `useEndpoint(getCompositionData,{})`, memo-deserializes the `EdgeGraph` + manifests once.
- **Active-composition store** (module-level external store via `useSyncExternalStore`, same shape as the pane-route store): holds the active draft `CompositionManifest | null`, an optional compare manifest (Inc 3), and a **derived membership `Map<PluginId,MembershipState>`** recomputed via `resolveComposition` whenever `(manifest, graph)` change — computed **once**, not per row. API: `useActiveComposition()`, `useActiveMembership()`, `setActiveComposition(m)`, `updateActiveDraft(patch)`, `pinAsRoot(id)`, `clearActive()`, compare-mode setters.
- `useInclusion(node)` / `useImpact(node)` — thin wrappers over `explainInclusion` / `impactOfSelecting` / `impactOfPruning` against the active draft + graph.

Boundary: Studio sub-plugins and `plugin-view` import `@plugins/plugin-meta/plugins/composition/web`; `composition` imports `closure/core` + `plugin-tree/core` only → DAG, no cycle.

## Increment 1 — read-only closure tint + why/impact

**Tree tint (full-row band).**
- `plugins/apps/plugins/studio/plugins/explorer/web/components/plugin-tree.tsx`: add `relative` to the `TreeRow` div (1 line — `plugin-tree.tsx:173`). Sole change to shared code.
- NEW sub-plugin `plugins/apps/plugins/studio/plugins/explorer/plugins/membership/web/` — contributes `Explorer.TreeRowBadge({ id:"membership", component: MembershipBand })` (mirror `…/explorer/plugins/child-count/web/index.ts`). `MembershipBand({node})` reads `useActiveMembership().get(node.id)`; renders `pointer-events-none absolute inset-0` band tinted by state (behind text; selection `bg-accent` layers on top). On hover, a small **"Show closure from here"** pin button calling `pinAsRoot(node.id)` (sets ad-hoc `{name:"(pinned)", entryPoints:[node.id], selectedContributors:[]}`). Returns `null` when no active composition (no tint by default).
- **Lint compliance:** band z-order via the `z-layers` primitive (no raw `-z-10`); state→color via theme/semantic classes (satisfy `no-hardcoded-colors`); spacing/text via `spacing`/`text` primitives.

**"Why included / impact" detail section.**
- NEW sub-plugin `plugins/plugin-meta/plugins/plugin-view/plugins/inclusion/web/` — contributes `PluginViewSlots.Section({ id:"inclusion", label:"Composition membership", component: InclusionSection })` (mirror `…/plugin-view/plugins/sub-plugins/web/index.ts`). `InclusionSection({node})` shows: membership state badge; **why bundled** = `explainInclusion` path rendered as hard/soft edge chips (`link-chip`); **impact** = `impactOfSelecting`/`impactOfPruning` counts + list; and a **"Show closure from here"** button (`pinAsRoot`).

Inc 1 stands alone: pin any plugin → tree tints by its closure; inspect any other node → see why it's (not) bundled relative to the pin.

## Increment 2 — named compositions pane + live draft editing

NEW plugin `plugins/apps/plugins/studio/plugins/compositions/web/` (mirror `…/studio/plugins/explorer/web/{panes.tsx,index.ts}`): `Pane.define({id:"compositions",chrome:false,width:…})` + `Pane.Register` + `Studio.Sidebar({…sidebarNavItem({title:"Compositions", icon, onClick:()=>openPane(compositionsPane,{},{mode:"root"})})})`.

Pane contents (reads `useCompositionData().manifests`):
- **List** of named compositions; selecting one calls `setActiveComposition(structuredClone(manifest))` (a draft) → tree tints via the same Inc 1 band.
- **Editor** on the draft via `updateActiveDraft`: toggle `selectedContributors` (from the `available` frontier) and entry points; each toggle re-resolves client-side → tint + detail update **instantly**. Show `impactOfSelecting`/`impactOfPruning` next to each toggle, and bundle summary (counts per state).
- **Draft-only:** a clear "Draft — not saved to repo" indicator. No disk writes. (Persistence to `<plugin>/composition/index.ts` is a deferred follow-up.)

## Increment 3 — composition diff

Extend the compositions pane with a **Compare** mode: pick A and B (default `agent-manager` vs `agent-manager-lean`). Resolve both client-side, compute bundle symmetric difference. The membership band sub-plugin gains a **diff color mode** (driven by a compare flag in the store): `only-A` / `only-B` / `both` / `neither`. Plus a feature-level delta list in the pane.

Anchor demo: the diff tints **exactly** the self-improvement subtree (`improve.element-picker, review, reports.crash, reports.launch-fix, screenshot.draw-on-app` + their `via-contributor` hard closure) as the delta.

**Closure-graph canvas** (greenfield DAG renderer, focused subgraph around a node) → **filed as a follow-up task** via `add_task` after approval; not built here.

## File map

**New**
- `plugin-meta/plugins/closure/core/serialize.ts` (+ barrel)
- `plugin-meta/plugins/composition/core/endpoints.ts` (+ barrel)
- `plugin-meta/plugins/composition/server/index.ts` (+ `CLAUDE.md`)
- `plugin-meta/plugins/composition/web/index.ts` (store + hooks) (+ `CLAUDE.md`)
- `apps/plugins/studio/plugins/explorer/plugins/membership/web/index.ts` + band component (+ `CLAUDE.md`)
- `plugin-meta/plugins/plugin-view/plugins/inclusion/web/index.ts` + section component (+ `CLAUDE.md`)
- `apps/plugins/studio/plugins/compositions/web/{index.ts,panes.tsx}` + components (+ `CLAUDE.md`)

**Changed**
- `apps/plugins/studio/plugins/explorer/web/components/plugin-tree.tsx` — add `relative` to `TreeRow` (1 line).

**Reuse:** `defineEndpoint`/`implement`/`useEndpoint` (`infra/endpoints`); `buildPluginTree` (`plugin-tree/core`); `classifyEdges`/`resolveComposition`/`explainInclusion`/`impact*` (`closure/core`); `loadCompositions` (`composition/core`); `Explorer.TreeRowBadge`, `PluginViewSlots.Section`, `Pane.define`/`Pane.Register`, `Studio.Sidebar`/`sidebarNavItem`/`openPane`; primitives `z-layers`, `text`, `spacing`, `link-chip`, `badge`, `toggle-chip`, `loading`.

Each new runtime plugin needs a `CLAUDE.md` (`plugins-have-claudemd`). `./equin build` regenerates the web/server registries + docs (`plugins-registry-in-sync`, `plugins-doc-in-sync`).

## Verification

- **Build:** `./equin build`, then `http://att-1781511041-v3sc.localhost:9000` → Studio.
- **Inc 1:** Explorer → pin `apps.agent-manager` (or any node) as root → tree tints (`required`/`available`/`excluded`); the whole `apps.sonata.*` subtree reads `excluded`. Open a plugin's detail → "Composition membership" shows the hard-edge "why included" path. `bun e2e/screenshot.mjs --url …/studio --click "Show closure from here" --out /tmp/inc1` for before/after.
- **Inc 2:** Compositions pane → select `agent-manager-lean` → tint updates; toggle `review` on → it flips to `contributor` and its closure tints live; "Draft — not saved" shown; confirm no file changed (`git status`).
- **Inc 3:** Compare `agent-manager` vs `agent-manager-lean` → diff highlights exactly the self-improvement set + closure as the delta; feature-delta list matches. Screenshot the compare view.
- **Engine regression:** `bun test plugins/plugin-meta/plugins/closure/core/closure.test.ts`; `./equin check composition-closure`.

## Follow-ups (filed, not built)

1. Closure-graph **canvas** (greenfield subgraph DAG renderer).
2. Composition **persistence — move manifests out of code.** Today a manifest is a `<plugin>/composition/index.ts` barrel discovered via build-time collected-dir codegen, so creating/editing one needs a rebuild — wrong shape for runtime UI editing. The task: **remove the barrel** and store manifests as plain data, investigating whether they can live in the **config system** (`config_v2` JSONC) so they're read/written at runtime with no codegen. This replaces `loadCompositions`'s generated-registry path with a runtime data source; the draft store from Inc 2 becomes the editor for it.
3. Tree-build **staleness** — invalidate the server graph cache on plugin-tree changes (git-watcher) if the process-lifetime cache proves stale.
