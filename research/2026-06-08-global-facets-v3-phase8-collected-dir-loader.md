# Facets v3 — Phase 8: generalize the build-time registration mechanism

> Follow-on to `2026-06-02-global-facets-rendering-separation-v3.md` (Phase 8 of its
> "Follow-on" list). This doc decides Phase 8 on its own merits and scopes the work.

## Context

Phase 8 was framed as: the codebase has *two* discovery mechanisms — explicit
slot/registration (web/server) vs. filesystem-walk + dynamic-import
(`CollectedDir` / `loadFacets`) for build-time contributors (`facet/`, `check/`,
`lint/`) — and we should generalize the slot mechanism to the build-time runtimes
so the dynamic-import pattern can be retired and discovery is uniform.

**Investigation found that premise is stale.** Discovery is *already* uniform.
All six runtimes — `web`, `server`, `central`, `check`, `lint`, `facet` — declare
`defineCollectedDir("X")` in their `core/` and are discovered by one codegen pass
(`generatePluginRegistry`, `codegen/core/plugin-registry-gen.ts`) that walks the
plugin tree and emits `<X>.generated.ts` with an identical `CollectedEntry[]` shape
(`{ pluginPath, hierarchyPath, loader: () => import(...), dependsOn }`), guarded by
the `plugins-registry-in-sync` check. There is **no** hardcoded `web/src/plugins.ts`
anymore — `web.generated.ts` is the truth. So web/server use the *same*
filesystem-walk + dynamic-import substrate as facet/check/lint; "retiring the
dynamic-import pattern" would mean retiring what web/server depend on.

**What actually differs is the consumption layer, not discovery:**
- web/server load a rich `PluginDefinition` with `contributions[]`, collected into
  `bySlot` / `byKind` and consumed via slots (`defineSlot`/`useContributions`,
  React) — many contributors, many consumers, slot owned by another plugin.
- facet/check/lint load a bare typed item, fed to a **single bespoke loader**
  (`loadFacets`, `loadAllChecks`, the eslint `lint/` walk) and a **single consumer**.

Two hard constraints rule out the literal "use slots for build-time" idea (so the
big "slot-ification" scope is rejected, consistent with v3 decision D1):
- The web slot system is React-context-bound (`PluginProvider`/hooks) — it cannot
  run in a plain CLI/jiti/build context.
- The eslint `lint/` loader cannot even use the generated `loader()`: jiti doesn't
  resolve `@plugins/*` aliases, so it reconstructs absolute paths itself
  (`eslint.config.ts:50-57`). `lint/` stays bespoke regardless.

**The only genuine duplication left** is that `loadFacets()`
(`facets/core/load-facets.ts`) and `loadAllChecks()`
(`checks/core/runner.ts:23-46`) are ~90% identical: `await import(generated)` →
`Promise.allSettled(loaders)` → type-guard filter → return array. `loadFacets`
adds a `dependsOn` topo-sort; `loadAllChecks` adds id-dedupe. Both are the same
"load a CollectedDir registry into typed items" operation.

**Decision (chosen scope): "Thin helper + doc fix."** Extract one shared
`loadCollectedDir<T>()` helper that subsumes both loaders; fix the stale docs that
still describe a "hardcoded plugin registry." Do **not** touch the slot system.

## What changes

### 1. New leaf plugin: `tooling/plugins/collected-dir`

The helper must be a dependency-free leaf — it **cannot** live in `codegen/core`
because `codegen → plugin-tree → facets` and `codegen → facets` are existing edges,
so `facets/core` importing `codegen/core` would close an import cycle (forbidden by
`plugin-boundaries`). A fresh leaf with zero cross-plugin imports is safely
importable by both `facets/core` and `checks/core`.

- NEW `plugins/framework/plugins/tooling/plugins/collected-dir/core/load-collected-dir.ts`
- NEW `plugins/framework/plugins/tooling/plugins/collected-dir/core/index.ts` (barrel)
- NEW `plugins/framework/plugins/tooling/plugins/collected-dir/package.json` + `CLAUDE.md`
  (autogen reference block added by `./equin build`)

```ts
// load-collected-dir.ts — zero cross-plugin imports (leaf)
export interface CollectedEntry {
  pluginPath: string;
  loader: () => Promise<{ default: unknown }>;
  dependsOn: string[];
}

export interface LoadCollectedDirOptions<T> {
  /** Type-guard that validates each loaded default export. */
  isItem: (v: unknown) => v is T;
  /** Topo-sort entries by `dependsOn` before loading (facets need this; checks don't). */
  ordered?: boolean;
  /** De-dupe loaded items by this key, keeping first (checks de-dupe by id). */
  dedupeKey?: (item: T) => string;
  /** Label for warn-on-reject logs, e.g. "facet" / "check". */
  label?: string;
}

export async function loadCollectedDir<T>(
  entries: CollectedEntry[],
  opts: LoadCollectedDirOptions<T>,
): Promise<T[]> {
  const ordered = opts.ordered ? topoSort(entries) : entries;
  const results = await Promise.allSettled(ordered.map((e) => e.loader()));
  const out: T[] = [];
  const seen = opts.dedupeKey ? new Set<string>() : null;
  for (let i = 0; i < results.length; i++) {
    const r = results[i]!;
    if (r.status === "rejected") {
      console.warn(`[${opts.label ?? "collected-dir"}] failed: ${ordered[i]!.pluginPath}`, r.reason);
      continue;
    }
    const exported = (r.value as { default?: unknown }).default;
    const items = Array.isArray(exported) ? exported : exported ? [exported] : [];
    for (const item of items) {
      if (!opts.isItem(item)) continue;
      if (seen && opts.dedupeKey) {
        const k = opts.dedupeKey(item);
        if (seen.has(k)) continue;
        seen.add(k);
      }
      out.push(item);
    }
  }
  return out;
}
// topoSort: move verbatim from load-facets.ts:19-37 (keyed on pluginPath, dependsOn).
```

Note: the helper takes the **already-loaded `entries` array**, not a module
specifier. This is deliberate — `loadFacets` holds `"./facet.generated"` in a
variable (`load-facets.ts:40-48`) so the web bundler cannot statically follow it
into `parse-utils` (fs/path). That trick must remain caller-side; a relative
specifier inside the helper would also resolve against the wrong module.

### 2. `loadFacets` delegates to the helper

EDIT `plugins/plugin-meta/plugins/facets/core/load-facets.ts`: keep the
non-literal `import("./facet.generated")` (bundler-safety) and `isFacet`; delete
the local `topoSort`; delegate. Net: file shrinks to the import + a one-line call.

```ts
import { loadCollectedDir } from "@plugins/framework/plugins/tooling/plugins/collected-dir/core";
import type { Facet } from "./facets";

function isFacet(v: unknown): v is Facet { /* unchanged */ }

export async function loadFacets(): Promise<Facet[]> {
  const generatedModule = "./facet.generated"; // non-literal: keep bundler blind
  const { facetEntries } = await import(generatedModule);
  return loadCollectedDir<Facet>(facetEntries, { isItem: isFacet, ordered: true, label: "facet" });
}
```

### 3. `loadAllChecks` delegates to the helper

EDIT `plugins/framework/plugins/tooling/plugins/checks/core/runner.ts`: keep
`isCheck`; replace the inline allSettled/dedupe loop with the helper.

```ts
import { loadCollectedDir } from "@plugins/framework/plugins/tooling/plugins/collected-dir/core";

async function loadAllChecks(): Promise<Check[]> {
  const { checkEntries } = await import("./check.generated");
  return loadCollectedDir<Check>(checkEntries, { isItem: isCheck, dedupeKey: (c) => c.id, label: "check" });
}
```
(`runChecks`/`listAllChecks` and the cache/run logic are untouched.)

### 4. `lint/` stays bespoke — document why

No code change to `eslint.config.ts`. Add a one-line comment at its load block
noting it cannot use `loadCollectedDir` (jiti can't resolve `@plugins/*`; it
reconstructs absolute paths and uses throw-on-failure semantics, not warn-skip).

### 5. Doc fixes (the "doc fix" half)

- `plugins/framework/plugins/web-sdk/CLAUDE.md` — the "Registering a plugin" /
  "File Structure" / "Adding a New Plugin" sections still say *"Add it to
  `web/src/plugins.ts`"* / *"Hardcoded plugin registry (static imports)"*. That
  file no longer exists; replace with the generated-registry reality
  (`web.generated.ts`, regenerated by `./equin build`, drift-checked by
  `plugins-registry-in-sync`).
- `plugins/plugin-meta/plugins/facets/CLAUDE.md` — the "Mental model" / "Adding a
  facet" sections describe `loadFacets()` discovery; add a sentence that
  `loadFacets` is now built on the shared `loadCollectedDir` helper (same uniform
  discovery substrate as `check`/`web`/`server`/...).

## Out of scope (explicitly not done)

- **Slot-ifying build-time runtimes** (the literal "generalize the slot mechanism"
  reading). Rejected on merits: each build-time runtime has a single consumer, and
  web slots are React-context-bound; v3 D1 already reached this conclusion.
- **`renderDoc` → slot migration** (the v3 hint). `renderDoc` is build-time and has
  a single consumer (docgen); it is not a browser slot. No change.
- **Consolidating the 6 inlined `defineCollectedDir` one-liner copies.** Each
  `*/core/collected-dir.ts` inlines its own `function defineCollectedDir` to avoid a
  dependency edge into `codegen/core`. With the new leaf plugin in place, the clean
  endpoint is to move `defineCollectedDir`/`CollectedDirDef`/`isCollectedDirDef`
  there too and have all 7 sites import it (the codegen scanner regex-greps the
  literal `defineCollectedDir("X")` call, so imported-vs-inlined is invisible to it).
  This is the structurally-correct single-home for the whole CollectedDir primitive,
  but it churns 7 files + the codegen barrel and is orthogonal to the loader dedup —
  **deferred as an optional follow-up**, not part of this thin deliverable.

## Critical files

| File | Change |
|---|---|
| `plugins/framework/plugins/tooling/plugins/collected-dir/core/load-collected-dir.ts` | NEW — generic `loadCollectedDir<T>` + `topoSort` (moved from load-facets) |
| `plugins/framework/plugins/tooling/plugins/collected-dir/core/index.ts` | NEW — barrel |
| `plugins/framework/plugins/tooling/plugins/collected-dir/package.json` | NEW — `{ "singularity": { "description": "…" } }` |
| `plugins/plugin-meta/plugins/facets/core/load-facets.ts` | EDIT — delegate; drop local `topoSort` |
| `plugins/framework/plugins/tooling/plugins/checks/core/runner.ts` | EDIT — `loadAllChecks` delegates |
| `eslint.config.ts` | EDIT — one comment explaining why `lint/` stays bespoke |
| `plugins/framework/plugins/web-sdk/CLAUDE.md` | EDIT — remove stale `web/src/plugins.ts` references |
| `plugins/plugin-meta/plugins/facets/CLAUDE.md` | EDIT — note shared loader |

## Verification

1. `./equin build` — succeeds; regenerates the new plugin's CLAUDE.md
   reference block and any registry entries.
2. `./equin check` — all pass. Specifically:
   - `plugin-boundaries` — confirms the new leaf introduces **no cycle** (the whole
     reason it isn't in `codegen/core`); confirms `facets/core` and `checks/core`
     legally import `@plugins/framework/plugins/tooling/plugins/collected-dir/core`.
   - `plugins-registry-in-sync` — unaffected (no generated-registry shape change).
   - `plugins-doc-in-sync` — passes after the CLAUDE.md edits + autogen.
   - `eslint`, `typescript` — pass.
3. `./equin check --list` returns the **same set of check ids** as before
   (proves `loadAllChecks` still discovers every check via the helper).
4. `docs/plugins-details.md` / `docs/plugins-compact.md` **byte-identical** before
   vs. after (proves `loadFacets` → docgen still extracts/renders every facet, with
   topo-order preserved). Diff with `git diff $(git merge-base HEAD main) -- docs/`.
5. Forge catalog/detail + a PR-style diff still render facet data (the facet
   pipeline is unchanged; this is a smoke check via `e2e/screenshot.mjs`).
