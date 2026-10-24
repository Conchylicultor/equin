# Composition manifest registry — discover & load named compositions

**Status:** Plan, ready to execute.
**Date:** 2026-06-14
**Category:** global (`plugin-meta`, `tooling/checks`, `apps/agent-manager`)
**Depends on:** the merged closure engine (`plugins/plugin-meta/plugins/closure/`, commit `f95a520af`).
**Parent vision:** [`research/2026-06-09-global-plugin-compositions.md`](./2026-06-09-global-plugin-compositions.md).

---

## Context

The repo must hold **many named compositions** — declarative, dependency-closed
selections over the plugin space — so the same monorepo can yield multiple
flavors of an app (e.g. agent-manager with vs without self-improvement). The
load-bearing piece, the **closure engine**, already landed: it computes a
bundle + membership from a `CompositionManifest` and answers "why is X
bundled / what does selecting Y add". What's missing is the **registry**: a
place to *write* compositions, a mechanism to *discover and load* them, and a
*validity gate* so a malformed composition fails the build instead of silently
half-resolving. The closure plugin's own CLAUDE.md names this exact increment as
"the manifest registry (`defineCollectedDir("composition")`) … the next
increment."

This slice delivers that registry. It is purely additive — it changes nothing
about what builds today (the web/server registries stay filesystem-derived and
complete). Build-gating a composition is explicitly future work.

### Key finding that shapes the design

The vision doc and the task brief describe the manifest as
`{ name, entryPoints, softOptOuts }` (opt-OUT). **The merged engine settled on
opt-IN instead** and already defines + exports the authoritative type
(`plugins/plugin-meta/plugins/closure/core/types.ts:48`):

```ts
export interface CompositionManifest {
  name: string;
  entryPoints: PluginId[];          // an umbrella entry ships its whole subtree
  selectedContributors: PluginId[]; // soft contributors explicitly opted IN
}
```

Nothing soft is bundled by default; a composition *adds* contributors, it never
prunes. `softOptOuts` is superseded. **Decision (confirmed): reuse the engine's
type verbatim — never redefine it.** Two definitions of the same shape would
need a sync check (the exact footgun CLAUDE.md warns against). The composition
plugin owns the *registry/loader*; the closure plugin owns the *type + engine*.

### Override-forbidden — enforced by construction

"A composition can only add plugins / opt in contributors, never replace a
plugin's file." This is structural, not policed: the manifest vocabulary
contains **only additive selections** (`entryPoints`, `selectedContributors`).
There is no field that points one plugin's file at another, so override is simply
*inexpressible*. Resolution is a pure union/hard-closure with no precedence
rules. The validity check (below) adds the second guarantee — every selection is
*real and meaningful* — but the no-override invariant needs no enforcement code.

---

## Design

### New plugin: `plugins/plugin-meta/plugins/composition/` (core-only)

Sibling of `closure` / `plugin-tree` / `facets` under the `plugin-meta`
umbrella. Core-only, no web/server, **no `definePlugin` / default export** —
mirror `closure`'s shape exactly (pure named-export barrel; `no-reexport-default`
does not apply to `core/`).

Files:

- **`core/collected-dir.ts`** — two lines, byte-for-byte mirror of
  `checks/core/collected-dir.ts:1` and `facets/core/collected-dir.ts:1`:
  ```ts
  import { defineCollectedDir } from "@plugins/framework/plugins/tooling/plugins/collected-dir/core";
  export const compositionCollectedDir = defineCollectedDir("composition");
  ```
  This single marker call is what codegen scans for; it auto-registers
  `composition/` as a standard plugin dir (`plugin-registry-gen.ts:115`) with
  zero edits elsewhere.

- **`core/is-composition.ts`** — `isCompositionManifest(v): v is CompositionManifest`
  type guard. Validates `name` is a non-empty string and `entryPoints` /
  `selectedContributors` are arrays of strings (PluginId is a branded string, so
  `typeof === "string"`). It does **not** check that ids resolve — that needs the
  tree and is the check's job. Imports `CompositionManifest` as a *type* from
  `@plugins/plugin-meta/plugins/closure/core`.

- **`core/load-compositions.ts`** — `loadCompositions(): Promise<CompositionManifest[]>`.
  Mirrors `facets/core/load-facets.ts:14` (the defensive variant), because Studio
  will import this client-side in a later increment:
  ```ts
  export async function loadCompositions(): Promise<CompositionManifest[]> {
    const generatedModule = "./composition.generated";        // non-literal: web bundler can't follow it
    const { compositionEntries } = await import(generatedModule);
    return loadCollectedDir<CompositionManifest>(compositionEntries, {
      isItem: isCompositionManifest,
      label: "composition",
    });
  }
  ```
  **No `dedupeKey`.** Silent keep-first dedupe would hide duplicate names from the
  validity check — uniqueness is enforced loudly by the check instead. (The check
  gates merges, so duplicates never reach runtime.)

- **`core/index.ts`** — barrel: re-export `compositionCollectedDir`,
  `isCompositionManifest`, `loadCompositions`. **Does NOT re-export
  `CompositionManifest`** — cross-plugin re-export is banned (boundary R: "No
  cross-plugin re-exports"); consumers import the type from `closure/core`
  directly.

- **`core/composition.generated.ts`** — emitted by `./equin build` codegen
  (`renderCollectedDirRegistry`), exporting `compositionEntries: CollectedEntry[]`.
  Committed; the `plugins-registry-in-sync` check enforces it stays current.

- **`core/load-compositions.test.ts`** (`bun:test`) — see Verification.
- **`package.json`** (mirror `closure/package.json`, name
  `@singularity/plugin-plugin-meta-composition`) + **`CLAUDE.md`**.

### Seed manifests (anchor demo): `plugins/apps/plugins/agent-manager/composition/index.ts`

Co-located with the app they compose. One file, `export default [ ... ]` (two
manifests — `loadCollectedDir` normalizes array exports). Imports `asPluginId`
from `@plugins/framework/plugins/plugin-id/core` and the `CompositionManifest`
type from `@plugins/plugin-meta/plugins/closure/core`.

- **`agent-manager`** (full): `entryPoints: [asPluginId("apps.agent-manager")]`,
  `selectedContributors:` a curated set drawn from the live `available` frontier
  that includes the **self-improvement** contributors (the `improve` / `review` /
  `reports` / `build` family) plus a few core app contributors.
- **`agent-manager-lean`**: same `entryPoints`, `selectedContributors` = the full
  set **minus** the self-improvement ids.

So `impactOfPruning` / set-difference between the two = **exactly the
self-improvement subtree** — the vision's anchor demo, now expressible.

> The implementer must draw every selected id from
> `resolveComposition(classifyEdges(tree), { entryPoints: [asPluginId("apps.agent-manager")], selectedContributors: [] }).available`
> so each one is a genuine soft option (the validity check rejects ids that
> aren't). Confirm the self-improvement plugins appear in that `available` list
> before hardcoding them; capture the exact ids from a one-off
> `bun` run of the engine, don't guess.

### Validity check: `plugins/framework/plugins/tooling/plugins/checks/plugins/composition-closure/check/index.ts`

Standard `check/index.ts` default-export (`export default check`), local
`type Check` alias (mirror `no-plugin-imports-in-core/check/index.ts`). Keep the
id `composition-closure` for continuity with the vision/closure docs; description
clarifies it is a **validity gate** (under opt-in, closedness is automatic).
`cacheSignature` may be omitted (it reads only the tree, which is already in the
default cache key).

`run()` builds the tree once (`buildPluginTree(root, { skipBarrelImport: true })`
+ `classifyEdges`, the way `plugins-registry-in-sync` obtains the root), loads all
manifests via `loadCompositions()`, and for each manifest enforces — failing
loudly with the offending id/name on first violation:

1. **Loads & well-formed** — already filtered by `isCompositionManifest`; a
   manifest file whose loader rejected is surfaced (compare loaded count vs
   `compositionEntries` count, or read the warn log) — at minimum, an empty
   `entryPoints` fails.
2. **Unique names** — duplicate `name` across all loaded manifests → fail.
3. **Ids resolve** — every `entryPoints` + `selectedContributors` id is a real
   node in the tree (`tree.byDir` / id lookup).
4. **No redundant selections** — `resolveComposition(...).redundantSelections`
   must be empty (a contributor already locked by hard edges is a manifest smell).
5. **Genuine soft options** — every `selectedContributors` id ends with
   membership `"contributor"` and has a soft edge into the bundle (it appears in
   the `available` frontier of the composition resolved *without* it). Rejects
   selecting an arbitrary unrelated plugin that would only ride in via hard
   closure.

Returns `{ ok: false, message, hint }` naming the composition + id on failure,
`{ ok: true }` otherwise. Runs automatically under `./equin check` and
`build` (discovered via the existing `defineCollectedDir("check")` sweep — no
registry edit).

---

## Critical files

**Reuse (read first):**
- `plugins/plugin-meta/plugins/closure/core/types.ts:48` — `CompositionManifest` (the type to reuse), `Composition`, `MembershipState`.
- `plugins/plugin-meta/plugins/closure/core/index.ts` — `resolveComposition`, `classifyEdges`, `impactOfPruning`, `impactOfSelecting`, `explainInclusion`.
- `plugins/framework/plugins/tooling/plugins/collected-dir/core/{define.ts,load-collected-dir.ts}` — `defineCollectedDir`, `loadCollectedDir`.
- `plugins/plugin-meta/plugins/facets/core/{collected-dir.ts,load-facets.ts}` — the loader template (non-literal specifier).
- `plugins/framework/plugins/tooling/plugins/checks/core/{collected-dir.ts,runner.ts}` — the dedupe/loader alternative.
- `plugins/framework/plugins/plugin-id/core/plugin-id.ts` — `PluginId`, `asPluginId` (dot-encoded: `apps.agent-manager`).
- `plugins/framework/plugins/tooling/core/types.ts` — `Check` / `CheckResult`.
- `plugins/framework/plugins/tooling/plugins/checks/plugins/{no-plugin-imports-in-core,plugins-registry-in-sync}/check/index.ts` — check + tree-build templates.
- `plugins/plugin-meta/plugins/closure/{package.json,core/index.ts}` — core-only plugin shape to mirror.

**New (to create):**
- `plugins/plugin-meta/plugins/composition/core/{collected-dir,is-composition,load-compositions,index}.ts` + `composition.generated.ts` (codegen) + `package.json` + `CLAUDE.md` + `core/load-compositions.test.ts`.
- `plugins/apps/plugins/agent-manager/composition/index.ts` — two seed manifests.
- `plugins/framework/plugins/tooling/plugins/checks/plugins/composition-closure/check/index.ts` (+ optional `CLAUDE.md`).

---

## Verification

1. **Build & codegen:** `./equin build`. Confirm
   `plugins/plugin-meta/plugins/composition/core/composition.generated.ts` is
   emitted with a `compositionEntries` entry for
   `apps/plugins/agent-manager/composition`, and `plugins-registry-in-sync`
   passes.
2. **Unit (this slice), `bun test plugins/plugin-meta/plugins/composition/core/load-compositions.test.ts`:**
   - `loadCompositions()` returns both `agent-manager` and `agent-manager-lean`.
   - Each resolves via `resolveComposition` with empty `redundantSelections`.
   - The full bundle ⊋ the lean bundle, and the set difference equals exactly the
     self-improvement plugin ids (the anchor-demo assertion).
3. **Check (happy path):** `./equin check composition-closure` passes.
4. **Check (loud failure):** temporarily add a manifest with a bogus
   `selectedContributors: [asPluginId("does.not.exist")]` and a duplicate `name`;
   confirm the check fails with a message naming the offending id and the
   duplicate name. Revert.
5. No web/server surface in this slice — Studio visualization is a later
   increment.

---

## Out of scope (future increments, per the vision)

- Studio tint / "why included" pane / composition diff UI.
- Build-gating: filtering `web.generated.ts` / `server.generated.ts` by a chosen
  composition.
- Capability ports and cross-source (multi-repo) composition.
- Per-runtime (web vs server) closure split — the engine unions runtimes for v1.
