# Derive plugin `id` from path (kill the hand-authored id field)

## Context

Plugin `id` is a free-form string each plugin barrel hand-writes
(`export default { id: "tasks", ... }`). Nothing enforces uniqueness, and the
three runtime loaders dedupe by `id` inside `topoSortPlugins` — so two plugins
declaring the same `id` causes one to be **silently dropped**, taking its
contributions and `register` entries with it (this already bit us once: a
sub-plugin squatting `id: "conversations"` silently dropped the top-level
`conversations` plugin's config registration; only noticed because a Settings
toggle never appeared).

The root cause is that `id` is a hand-typed value that *duplicates information
the build already owns*: the codegen computes a structurally-unique path for
every plugin (`pluginPath` / `hierarchyPath`) and already injects
`_hierarchyPath` onto every loaded plugin. Most hand-written ids are just
manual (and drift-prone) transcriptions of that path.

**Decision (this plan):** stop hand-authoring `id`. Derive it from the unique
hierarchy path the codegen produces. This makes duplicate ids **impossible by
construction** — the entire bug class disappears, no runtime guard or build
check needed. (External/marketplace namespacing — a publisher scope prefix — is
explicitly deferred to a later plan.)

## End-state design

- **One identity field, never authored.** `id` becomes a runtime-injected value
  equal to the plugin's `hierarchyPath` (slash form, no `/plugins/` segments).
  Examples:
  - `tasks` → `id: "tasks"` (unchanged — top-level)
  - jsonl-viewer bash tool-call → `id: "conversations/conversation-view/jsonl-viewer/tool-call/bash"`
    (was the hand-written `conversation-jsonl-viewer-tool-call-bash`)
- `hierarchyPath` is **structurally unique** (directory paths can't collide), so
  ids can't collide. The `topoSortPlugins` silent-drop becomes unreachable.
- The authored type loses `id`; a separate runtime type carries it, so readers
  stay strongly typed without `?`/`!` noise.

### Why `hierarchyPath` (slash form) specifically
It is the value already injected as `_hierarchyPath` and already used by
`config_v2` for on-disk config file paths — zero new derivation logic, and
`id` ends up equal to `_hierarchyPath`. (`name` stays hand-authored for
display.)

## Scope of `id` readers (from audit)

- **Display/log only** (harmless): `[plugin.${p.id}]` logs, profiler/register
  span labels, topo cycle messages — web-sdk `context.tsx`, server/central
  `bin/index.ts`, all three `topo.ts`.
- **Runtime-internal keys** (safe — value stays unique within a run): topo
  `visited`/`stack`; server `onReady` `resolved` map; `_pluginId` stamping on
  contributions (`context.tsx`, server `contributions.ts`).
- **`dependsOn` is path-based already** (resolved via the `byPath` map keyed on
  `pluginPath`), *not* id-based — not a concern.
- **No hard-coded literal-id cross-plugin lookups exist** (no `=== "tasks"`
  style references to update).
- **Persisted (the one true migration surface):** `reorder` stores
  `${_pluginId}:${contributionId}` as the PK `contribution_id` in
  `reorder_prefs` and `reorder_group_members`. Changing a plugin's id orphans
  its persisted ranks / group memberships.
  - *Not affected, despite looking similar:* `plugin_health_reviews.plugin_id`
    (keyed on `node.hierarchyId` from the plugin tree, not `PluginDefinition.id`),
    `workflow_execution_steps.step_plugin_id` (a separate step-type registry id),
    `tabbed-view` localStorage keys (independent hand-passed strings). None read
    `PluginDefinition.id`.

## Implementation steps

### 1. Type plumbing (web + server)
- `plugins/framework/plugins/web-sdk/core/types.ts`: remove `id` from the
  **authored** `PluginDefinition`. Add a runtime type
  `LoadedPlugin = PluginDefinition & { id: string; _hierarchyPath?: string }`.
  Keep the `PluginId` alias.
- `plugins/framework/plugins/server-core/core/types.ts`: same split for
  `ServerPluginDefinition` → `LoadedServerPlugin`.
- Barrels keep `satisfies PluginDefinition` / `satisfies ServerPluginDefinition`;
  because `id` is gone from the authored type, the excess-property check forces
  every barrel to drop its `id:` line (step 2).

### 2. Codemod: strip `id:` from all barrels
- All 396 barrels are uniform `export default { id: "...", name: ..., ... }
  satisfies …PluginDefinition`. A scripted edit removes the single
  `^\s*id:\s*["'\`]…["'\`],?\n` line from each `plugins/**/{web,server}/index.ts`.
  Mechanical, large diff. (Central excluded — see step 6.)

### 3. Inject derived id in the loaders
- web `…/web-sdk/core/loader.ts` (~line 27): alongside `_hierarchyPath`, set
  `plugin.id = entry.hierarchyPath`; type the result `LoadedPlugin[]`.
- server `…/server-core/bin/index.ts` (~line 25): set
  `plugin.id = e.hierarchyPath`; type `byPath` as `LoadedServerPlugin`.
- In each loader's id-assignment loop, track a `Set<string>` and **throw** if a
  derived id repeats (cheap invariant assertion; should be unreachable given
  path uniqueness, but fails loud if codegen ever regresses). This *replaces*
  the originally-requested build-time check and the topo silent-drop concern.
- Update framework reader types to `LoadedPlugin`/`LoadedServerPlugin`:
  `context.tsx` (`PluginRuntime.plugins`), `topo.ts` signatures already generic
  (no change), `bin/index.ts` maps.

### 4. reorder data migration
- Compute the changed-id set: a one-off script lists every plugin where the old
  hand-written id ≠ its `hierarchyPath` (capture old ids from git/barrels
  *before* the codemod).
- Query `reorder_prefs` / `reorder_group_members` (via `query_db`) for rows
  whose `contribution_id` prefix is in the changed set.
  - **If none** (likely — reorderable slots are sidebar/toolbar, contributed
    mostly by top-level plugins whose id already equals their path): no
    migration; note it in the PR.
  - **If some:** generate an idempotent data migration rewriting the prefix:
    `contribution_id = '<newId>' || substring(contribution_id from position(':' in contribution_id))`
    `WHERE contribution_id LIKE '<oldId>:%'`, one statement per changed plugin
    that has rows. Go through `./equin build` (never hand-run drizzle).

### 5. Build, regenerate, verify in-sync
- `./equin build` regenerates the plugin registries and docs. Docgen is
  blind to the barrel `id` (it derives everything from paths), so
  `plugins-doc-in-sync` and the registry stay consistent. Run
  `./equin check`.

### 6. central-core (NEEDS YOUR EXPLICIT APPROVAL)
Central plugins (5: `auth`, `auth-google`, `auth-notion`,
`config-v2-fields-secret`, `secrets`) also hand-author `id`. Deriving theirs
requires editing `central-core/core/types.ts` and `central-core/bin/index.ts`,
which CLAUDE.md forbids without explicit in-conversation approval.

- **Recommended:** include central for consistency (same 3 edits as
  web/server), pending your approval.
- **Fallback if you'd rather not touch central-core now:** leave the 5 central
  plugins hand-authoring `id`, and instead add the small build-time
  duplicate-id `./equin check` *for central only* as a backstop. Slight
  inconsistency, documented.

## Critical files

- `plugins/framework/plugins/web-sdk/core/types.ts`, `…/loader.ts`,
  `…/context.tsx`, `…/topo.ts`
- `plugins/framework/plugins/server-core/core/types.ts`, `…/bin/index.ts`,
  `…/core/contributions.ts`
- (pending approval) `plugins/framework/plugins/central-core/core/types.ts`,
  `…/bin/index.ts`
- All `plugins/**/{web,server}/index.ts` barrels (codemod, id: line removal)
- `plugins/reorder/server/internal/{tables.ts,handlers.ts}` +
  `plugins/reorder/plugins/groups/server/internal/*` — only if step-4 migration
  is needed (no schema change, data migration only)

## Verification

1. `./equin build` succeeds; server restarts clean (no duplicate-id throw,
   no load failures).
2. `./equin check` passes (`migrations-in-sync`, `plugins-doc-in-sync`,
   `eslint`, boundaries).
3. App loads at `http://<worktree>.localhost:9000`: the previously-affected
   surfaces are intact — Settings toggles present, sidebar/toolbar render all
   contributions. Spot-check via Playwright (`e2e/screenshot.mjs`).
4. reorder: drag-reorder + hide + group a sidebar item, reload, confirm it
   persists (proves the new `id`-based key round-trips). If the step-4 migration
   ran, confirm pre-existing custom orders survived.
5. `query_db` sanity: `SELECT DISTINCT split_part(contribution_id, ':', 1) FROM
   reorder_prefs` shows the new path-form ids, no orphaned old-form prefixes.
6. Negative check: temporarily duplicate a directory's hierarchy to confirm the
   loader throws loudly (then revert).

## Deferred (explicitly out of scope)

- Publisher-scope namespacing for external/marketplace plugins (the global
  uniqueness layer) — separate future plan.
- Collapsing `_hierarchyPath` into `id` (they become byte-identical here).
  Possible follow-up; left separate to keep this change's blast radius focused
  and avoid extra churn in `config_v2` / contribution stamping.
