# Config.Section primitive + commits stats refactor

## Context

The `config` plugin today only models **flat scalar preferences** — `string`, `number`, `boolean`, `string-list`. It auto-generates a UI from those fields and stores values in a single `config(key, value)` table.

This breaks down as soon as a setting has **sub-state per item**. Concrete trigger: in `plugins/stats/plugins/commits`, we want to

1. Remove the `excludedShas` filter entirely — it was a blunt hammer and paths-based filtering subsumes it.
2. Replace the single "All paths / Excluding filtered paths" toggle in the lines charts with **one toggle per path** in the `excludedPaths` list, so a user can opt in/out of each folder and see the diff recompute.

The `excludedPaths` *list* is a genuine persistent preference (defaults matter, users edit it in Settings). The per-path *active/inactive toggle* is a second dimension: it's not a new top-level scalar, it's sub-state attached to each list item. The current primitive has no good place for it.

The broader problem, beyond this toy example: **how should plugins declare settings that have structure?** Modern apps split this cleanly:

- Scalars → JSON/schema config, auto-generated UI (VSCode `settings.json`, Raycast prefs).
- Structured / user-managed items → their own storage + bespoke UI (VSCode keybindings editor, Linear/Notion's "everything is data").

Trying to build a *generic structured-config primitive* tends to reinvent a weaker document DB — weaker types, no relational integrity, harder queries, still needs a custom UI. The win (no new table) is small since tables are cheap.

## Design

Keep the `config` plugin's existing `defineConfig` / `Config.Spec` path untouched — it's the right shape for scalars. Add one escape hatch:

### New contribution: `Config.Section`

A component slot in the `config` plugin (sibling to `Config.Spec`). A plugin that needs a structured settings UI contributes a React component; the Settings pane mounts it as its own section, grouped under the plugin's name alongside any scalar fields it also declares.

```ts
// plugins/config/web/slots.ts
import type { ComponentType } from "react";

export const Config = {
  Spec: defineSlot<ConfigDescriptor>("config.spec"),
  Section: defineSlot<{
    id: string;       // stable id within the plugin (e.g. "excluded-paths")
    title: string;    // section header
    component: ComponentType;
  }>("config.section"),
};
```

The plugin owns its own storage, API routes, and the editor UI. No attempt to make the config plugin a document store.

### Storage convention (no library yet)

For structured settings state, **establish a naming convention, not a helper library**:

- Table name: `<plugin_id_with_underscores>_<collection>` — e.g. `stats_commits_excluded_path_state`.
- Schema lives at `plugins/<path>/server/schema.ts`, registered via the existing barrel export in `server/src/db/schema.ts`.
- If realtime sync is needed, the plugin defines a push resource with key `<plugin-id>.<collection>`.

**Why convention over a library now.** We have exactly one use case (`excluded_path_state`). A `defineCollection({ fields, ui })` helper that wires table + REST + resource + UI would be premature abstraction against a sample size of one. If the same shape appears in a second and third plugin, extract a helper then — the convention makes the eventual extraction trivial. Documented in `plugins/config/CLAUDE.md` (new, small) so the pattern is visible.

### Settings pane changes

`plugins/config/web/components/settings-panel.tsx` is the single place that renders per-plugin groups. It currently groups `Config.Spec` fields by plugin id. Extend it to also collect `Config.Section` contributions, group by plugin id alongside fields, and render sections **below** auto-generated fields within the same plugin group. A plugin with only sections (no `Config.Spec`) still gets a group.

### First consumer: stats-commits

**Config changes** — `plugins/stats/plugins/commits/shared/config.ts`:

- Remove `excludedShas`.
- Keep `excludedPaths` (still a `string-list` — the source-of-truth list of filterable folders, editable from Settings).

**New plugin-owned table** — `plugins/stats/plugins/commits/server/schema.ts` (new file):

```ts
export const excludedPathState = pgTable("stats_commits_excluded_path_state", {
  path: text("path").primaryKey(),
  enabled: boolean("enabled").notNull().default(true),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});
```

Registered via `export *` in `server/src/db/schema.ts` (same pattern as `plugins/tasks/server/schema.ts`).

**Active-subset derivation**: active paths = `excludedPaths ∩ { row.path where row.enabled, falling back to default true if no row exists }`. Rows only exist for explicit overrides, so the default state of a path added to `excludedPaths` in Settings is *on*.

**New HTTP endpoints** in `plugins/stats/plugins/commits/server/index.ts`:

- `GET /api/stats/commits/excluded-path-state` — returns the overrides map `{ [path]: boolean }`.
- `PATCH /api/stats/commits/excluded-path-state` — body `{ path, enabled }`, upsert.

**Push resource** `stats-commits.excluded-path-state` so UI auto-refreshes.

**Server handlers** — `handle-cumulative.ts` / `handle-rate.ts`:

- Drop the `excludedShas` filter.
- Replace `excludePaths=true` boolean query param with `activePaths=<comma-separated>` (or repeated param). The server already reads `commitsConfig.excludedPaths`; intersecting with the request-supplied active subset is a one-liner.

**UI changes** — `plugins/stats/plugins/commits/web/components/lines-charts.tsx`:

- Replace the single "All paths / Excluding filtered paths" button with a row of pill toggles, one per entry in `excludedPaths` (read via `useConfigValues(commitsConfig)`, merged with the overrides resource).
- Clicking a pill issues `PATCH /api/stats/commits/excluded-path-state` and the push resource re-renders with fresh data.
- The charts' fetch URLs include the active subset so the server recomputes diffs accordingly.

**Config section contribution** — `plugins/stats/plugins/commits/web/index.ts`:

```ts
Config.Section({
  id: "excluded-path-state",
  title: "Excluded path toggles",
  component: ExcludedPathToggles,
}),
```

Same `ExcludedPathToggles` component can be rendered both inside `LinesChartsSection` and in the Settings pane — one source of truth.

## Critical files

- `plugins/config/web/slots.ts` — add `Config.Section`.
- `plugins/config/web/components/settings-panel.tsx` — render sections per plugin group.
- `plugins/config/CLAUDE.md` — new, short: document the scalar-vs-structured boundary and the naming convention.
- `plugins/stats/plugins/commits/shared/config.ts` — drop `excludedShas`.
- `plugins/stats/plugins/commits/server/schema.ts` — new table.
- `server/src/db/schema.ts` — register the new schema export.
- `plugins/stats/plugins/commits/server/index.ts` — new routes + push resource + drop sha filter.
- `plugins/stats/plugins/commits/server/internal/handle-cumulative.ts`, `handle-rate.ts` — replace filter wiring.
- `plugins/stats/plugins/commits/web/components/lines-charts.tsx` — pill toggles.
- `plugins/stats/plugins/commits/web/components/excluded-path-toggles.tsx` — new, reused in charts + Settings section.
- `plugins/stats/plugins/commits/web/index.ts` — add `Config.Section` contribution.
- `docs/plugins.md` — regenerated to reflect `Config.Section` slot + new routes/resource.

## Reused surface area

- `defineSlot` (`plugin-core/slots.ts`) — the `Stats.Chart` slot at `plugins/stats/web/slots.ts:4-10` is the component-slot analog to model `Config.Section` after.
- `PluginRuntimeContext` injection of `_pluginId/_pluginName` (`plugin-core/context.tsx:19-26`) and the `useSpecsWithPlugin()` pattern (`plugins/config/web/slots.ts:25-45`) — mirror for `useSectionsWithPlugin()`.
- `buildGroups` in `plugins/config/web/components/settings-panel.tsx:20-38` — extend to include sections in each group.
- `defineResource` push-resource pattern used at `plugins/config/server/internal/resource.ts:1-14`.
- `useConfigValues(commitsConfig)` (`plugins/config/web/api.ts:5-22`) — still the right way to read `excludedPaths`.
- DB schema registration pattern (`plugins/tasks/server/schema.ts` + re-export in `server/src/db/schema.ts`).

## Verification

1. `./equin build` — regenerates migration for `stats_commits_excluded_path_state`, rebuilds frontend + server, notifies gateway.
2. Open `http://<worktree>.localhost:9000/stats`:
   - "Lines changed" section shows one pill per `excludedPaths` entry, all on by default.
   - Clicking a pill flips it off; charts refetch and show a new diff.
   - Refresh the page — toggle state persists (DB-backed).
3. Open `http://<worktree>.localhost:9000/settings`:
   - "Stats: Commits" group shows the `excludedPaths` string-list field **and** an "Excluded path toggles" section below it.
   - Toggling a pill in either place updates the other within ~1s (push resource).
4. Add a new path to `excludedPaths` in Settings — it appears as a new pill (default on) in both places without a reload.
5. Remove a path from `excludedPaths` — its override row is no longer referenced (safe to leave; table rows are scoped by membership at query time).
6. `./equin check --migrations-in-sync` — passes.
7. Grep the repo: no remaining references to `excludedShas` or `excludeShas`.

## Follow-ups (explicitly out of scope)

- `defineCollection` helper — only extract if a second plugin needs the same "list with per-item state" shape.
- Generic "collection editor" UI primitive — same rule.
- Cleanup job for orphan `excluded_path_state` rows after `excludedPaths` edits — trivial, defer until it matters.
