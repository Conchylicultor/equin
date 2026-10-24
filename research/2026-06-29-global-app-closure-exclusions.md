# App closure exclusions — structural guard against agent/worktree/git coupling

## Context

For a composition (e.g. **Sonata**) to be released as a self-contained app, its
plugin closure must not pull in agent-manager / worktree / git / agent-runtime
infrastructure (`conversations`, `tasks`, `infra/worktree`, `infra/git-watcher`,
`infra/claude-cli`, central `auth`, …). Those plugins assume a multi-worktree
dev environment and a shared central process; bundling them into a standalone
release silently bloats or breaks it.

Today nothing prevents an app plugin from *accidentally* importing such infra
(directly or transitively through an innocent-looking shared plugin). The fix is
a **build-time structural guard** so the whole class of accidental coupling is
caught at `./equin check` time, not per-instance.

**Finding (corrected after building the guard):** Sonata's *own* imports are
clean, but its *composition* is NOT. Every app `extends` `served-baseline`, which
seeds `infra.health`; `infra.health`'s `wedge-watchdog.tsx` hard-imports
`reports/web`; `reports/server` hard-imports `tasks` + `build/server`; `build`
hard-imports `git-watcher` (→ `worktree`). So a single edge
(`infra.health → reports`) drags the whole agent-runtime stack into the hard
closure of **every** served app. The guard caught this immediately.

**Decision:** Land the guard mechanism now (no app opts in yet — none is actually
clean), and file the `infra.health → reports` decoupling as the follow-up the
guard enables (task `task-1782748684227-5awz5n`). Once cut, opt clean apps in by
setting their composition `excludes`.

## Design — `excludes`, the dual of `extends`

Everything is **config-driven and composition-shaped** — no hardcoded plugin
lists in code.

1. **Forbidden infra is just a bundle** — an ordinary composition in the
   `compositions` config. The existing `subsystem` bundles already cover most of
   it (`conversations`, `tasks-domain`, `auth`). We add one aggregate bundle,
   `agent-runtime`, that reuses them via `extends` and adds the deep taproots.

2. **Apps declare exclusions as data** — a new `excludes: string[]` manifest
   field (the mirror of `extends`): the bundle NAMES an app's closure must stay
   disjoint from. `auth` stays a *separate* bundle, so it is excludable
   **on demand** — an app forbids it only if it lists it.

3. **A check enforces disjointness** between an app's resolved bundle
   (hard-closure — what actually ships) and the **containment** (entry + subtree,
   NOT hard-deps) of each excluded bundle. Using containment (not the excluded
   bundle's own hard-closure) means generic shared infra is never over-forbidden,
   while taproots listed in the bundle still catch transitive contamination —
   because the app's hard-closure surfaces any taproot it reaches.

### Why containment, not the excluded bundle's closure

`agent-runtime`'s hard-closure includes `database`, `jobs`, etc. (its own deps) —
forbidding those would break every app. Instead the forbidden set is the excluded
bundle's **owned plugins**: each entry/contributor id plus its `subtree`. Generic
deps are not owned by `agent-runtime`, so apps keep using them. But the *app's*
side is the full hard-closure, so `app → someSharedPlugin → infra.worktree` still
lands `infra.worktree` in the app bundle, where it intersects `agent-runtime`'s
containment (which lists `infra.worktree` as a taproot entry) → caught.

## Changes

### 1. Config schema + bundle — `plugins/plugin-meta/plugins/composition/core/config.ts`

- Add `excludes: stringListField({ label: "Excludes" })` to `manifests.itemFields`
  (after `extends`). `CompositionManifestItem` derives from the config, so it
  picks up `excludes` automatically.
- Add an `excludes` param (default `[]`) to the `app()` / `subsystem()` / `pack()`
  seed helpers so every seed carries the field.
- Add the aggregate forbidden bundle (rank e.g. `"aJ5"`, between `tasks-domain`
  and `page-editor`):
  ```ts
  // The agent-runtime infra closure: what a self-contained app must NOT bundle.
  // Reuses the conversations/tasks-domain subsystems and adds the deep taproots
  // (worktree/git/claude-cli) + the agent-manager app shell. `auth` is a SEPARATE
  // bundle — excluded on demand, not folded in here.
  {
    id: "agent-runtime", rank: "aJ5", name: "agent-runtime", category: "subsystem",
    entryPoints: [
      "infra.worktree", "infra.git-watcher", "infra.claude-cli",
      "apps.agent-manager",
    ],
    selectedContributors: [], excludes: [],
    extends: ["conversations", "tasks-domain"],
  }
  ```
- **No app opts in yet.** The intended Sonata opt-in
  (`app("sonata", "a6", "apps.sonata", [], ["agent-runtime", "auth"])`) is
  deferred until the served-baseline coupling is cut — today it would (correctly)
  fail the guard. The mechanism is live; opting an app in is a one-line config
  edit once it is genuinely clean.

> `excludes` is **not** added to the engine's `CompositionManifest` type
> (`closure/core/types.ts`) nor to `manifestItemToManifest` — it is engine-opaque
> metadata like `category`/`id`/`rank`. The engine's additive-only invariant is
> preserved; only the check reads `excludes`.

### 2. Enforcement — extend `composition-closure` check

`plugins/framework/plugins/tooling/plugins/checks/plugins/composition-closure/check/index.ts`

Extend the existing check (reuses its tree build + edge graph + config read; no
second `buildPluginTree`). Iterate the **raw** `values.manifests` items (it
already has them) so `excludes` is visible. Add:

- **Rule: `excludes` refs resolve.** Every name in `item.excludes` must be a
  known composition name (same pattern as the existing `extends` validation).
- **Rule: closure disjointness.** For each item with non-empty `excludes`:
  - `appBundle = resolveComposition(graph, flattenManifest(manifestItemToManifest(item), manifests)).bundle`
  - For each excluded name → its item → `flat = flattenManifest(...)` → compute
    **containment**:
    ```ts
    const containment = new Set<PluginId>();
    for (const id of [...flat.entryPoints, ...flat.selectedContributors]) {
      containment.add(id);
      for (const d of graph.subtree.get(id) ?? []) containment.add(d);
    }
    ```
  - `offenders = [...appBundle].filter((p) => containment.has(p))`
  - If non-empty → `fail(...)` naming the composition, the excluded bundle, the
    offending plugin(s), and an `explainInclusion(graph, flat, offender)` path
    (already exported) showing how it's pulled in — so the message is actionable.

Update the check's `description`, this plugin's `CLAUDE.md`, and the composition
plugin's `CLAUDE.md` (the "Override is forbidden" section) to document `excludes`
as the one *subtractive assertion* (it forbids membership, it cannot
replace/redirect — the additive-only resolution invariant is intact).

### 3. Tests

- `plugins/plugin-meta/plugins/composition/core/config.test.ts` — extend the
  schema-parse assertions to include `excludes`; assert the new `agent-runtime`
  bundle exists and that `sonata.excludes` is set.

## Critical files

| File | Change |
|---|---|
| `plugins/plugin-meta/plugins/composition/core/config.ts` | `excludes` field; `agent-runtime` bundle; Sonata opt-in; helper params |
| `plugins/.../checks/plugins/composition-closure/check/index.ts` | `excludes`-resolves rule + closure-disjointness rule |
| `plugins/.../checks/plugins/composition-closure/CLAUDE.md` | document the new rules |
| `plugins/plugin-meta/plugins/composition/CLAUDE.md` | document `excludes` semantics |
| `plugins/plugin-meta/plugins/composition/core/config.test.ts` | cover `excludes` + new bundle |

**Reused (no new machinery):** `buildPluginTree`, `classifyEdges`,
`flattenManifest`, `resolveComposition`, `explainInclusion`, `EdgeGraph.subtree`
(all from `plugin-meta/closure/core`); `readTypedConfig` + `fileConfigProxy`
(already in the check); `stringListField`.

## Verification (end-to-end)

1. `./equin build` — regenerates `compositions.origin.jsonc` from the new
   defaults (and picks up the schema change). **Passes** (no app `excludes` the
   `agent-runtime` bundle yet, so the guard finds nothing to flag).
2. **Guard works (demonstrated):** temporarily set
   `app("sonata", …, [], ["agent-runtime"])` and run
   `./equin check composition-closure` → it **fails**, naming `apps.sonata`,
   bundle `agent-runtime`, offenders `infra.git-watcher, infra.worktree,
   tasks.container-tasks, tasks.tasks-core`, with the inclusion path
   `infra.health → reports → build → infra.git-watcher`. Reverted.
3. `bun test plugins/plugin-meta/plugins/composition/core/config.test.ts` — passes.

## Out of scope / follow-ups

- **No taproot auto-discovery beyond config.** New top-level agent-runtime infra
  must be added to the `agent-runtime` bundle's `entryPoints` (a config edit, like
  any composition). This is the deliberate config-driven choice; if drift becomes
  a problem, a future enhancement could derive the taproot set structurally.
- `excludes` is evaluated on each composition's own item (not unioned through
  `extends`). Folding `excludes` through `extends` is a trivial later addition.
- Optional: have `./equin release` surface this check's failure prominently
  for the target composition (it already runs all checks).
