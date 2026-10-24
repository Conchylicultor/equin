# Derived-view registration via server contribution (kill the import-side-effect footgun)

## Context

The recently-landed derived-views work (commits `1f9e1d9`, `8da715a`) lifted plain
DB views out of drizzle's stateful migration layer: each owning plugin defines its
views in `server/internal/views.ts` and calls `defineView({ view })` at the bottom
of that file; `rebuildDerivedViews(db)` (database plugin's `onReadyBlocking`)
`DROP`/`CREATE`s the whole registered set from source on every boot.

**The footgun:** `defineView()` registers as an **import side-effect** into a
module-level array (`derived-views/core/internal/registry.ts`). `rebuildDerivedViews`
only sees views whose `views.ts` was *imported by something* before boot. Today every
`views.ts` happens to be transitively imported (e.g. tasks-core's `resources.ts`
imports the view objects, agents' barrel re-exports them), so registration runs. But
this is latent: a future plugin could `defineView` in a module that nothing imports at
boot, and the view would **silently never be created** — no error, just a missing
relation that surfaces much later as a query failure. Worse, the failure is *insidious*:
the author wrote `defineView` correctly; module load order alone decides whether it runs.

**Goal:** a structural guarantee that every defined view is registered and created,
with zero dependence on import order.

## Decision: declare views as a server *contribution*, not an import side-effect

We do **not** need any new discovery mechanism (collected-dir, content-scan codegen, a
new top-level dir, or a new check). The plugin framework **already** enumerates every
plugin's server definition at boot (`server.generated.ts` → `serverEntries`, loaded in
`server-core/bin/index.ts`) and exposes a first-class field for exactly this kind of
cross-plugin declarative data: **`contributions: ServerContribution[]`** on
`ServerPluginDefinition`.

`collectContributions(ordered)` (`server-core/bin/index.ts:72`) walks **all** loaded
plugins and indexes their contributions **before any `onReadyBlocking` runs**. A
consumer then calls `Token.getContributions()` and gets the complete cross-plugin list.
This is the blessed, widely-used pattern — `Trigger` (events), `Resource.Declare`,
`ConfigV2.Register`, `ReportKind`, `BackupTarget` all work this way, none via import
side-effects.

Moving view registration onto this mechanism **structurally eliminates** the insidious
failure: registration lives on the plugin definition, which the framework *always*
loads, and contributions are *always* collected before the rebuild. The only residual
is "you forgot to list a view in `contributions`" — a visible, obvious omission in your
own plugin definition (identical to forgetting a `Trigger`), which surfaces loudly at
first query. The repo deliberately adds no containment check for any other contribution,
so we add none here either.

### Why this beats the alternatives considered

| | **Contribution field (chosen)** | collected-dir `db-view/` | content-scan codegen |
|---|---|---|---|
| New top-level dir | No | Yes | No |
| New codegen / generated file | No | Yes | Yes |
| New discovery check needed | No (framework enumerates) | reuses one | must write one |
| Touches db-schema facet / query sites | No | shim: no / move: yes | No |
| Reuses an existing primitive | **Yes — server contributions** | yes | no |

## Implementation

### 1. Define the `View` contribution token (derived-views)

New file `plugins/database/plugins/derived-views/server/internal/contribution.ts`
(mirrors `events/.../trigger-contributions.ts`):

```ts
import { defineServerContribution } from "@plugins/framework/plugins/server-core/core";
import type { PgView } from "drizzle-orm/pg-core";

// A plugin declares each of its derived (plain) views here, in its server plugin
// definition's `contributions: [...]`. Collected at boot before onReadyBlocking, so
// rebuildDerivedViews sees every view regardless of module import order.
export const View = defineServerContribution<{ view: PgView; dependsOn?: string[] }>("derived-view");
```

Export it from the server barrel `plugins/database/plugins/derived-views/server/index.ts`:

```ts
export { rebuildDerivedViews } from "./internal/rebuild";
export { View } from "./internal/contribution";
```

### 2. `rebuildDerivedViews` reads contributions instead of the global array

`plugins/database/plugins/derived-views/server/internal/rebuild.ts`:

```ts
import { getViewConfig } from "drizzle-orm/pg-core";
import { View } from "./contribution";
import { topoSortViews, compileCreateView, type RegisteredView } from "@plugins/database/plugins/derived-views/core";

const declared: RegisteredView[] = View.getContributions().map(({ view, dependsOn }) => ({
  name: getViewConfig(view).name,
  view,
  dependsOn: dependsOn ?? [],
}));
const ordered = topoSortViews(declared);
// ...unchanged drop-reverse / create-forward transaction...
```

`topoSortViews` and `compileCreateView` are unchanged (they already operate on
`RegisteredView`). The `database` plugin's `onReadyBlocking` ordering is already correct:
`collectContributions` runs before it.

### 3. Delete the import-side-effect registry

- `derived-views/core/internal/registry.ts` — remove the module-level `views` array,
  `defineView`, and `getRegisteredViews`. **Keep** the `RegisteredView` interface (still
  the shape consumed by `topoSortViews`/`compileCreateView`).
- `derived-views/core/index.ts` — drop the `defineView` / `getRegisteredViews` exports;
  keep `RegisteredView`, `topoSortViews`, `compileCreateView`.

### 4. Each owning plugin declares its views in `contributions`

**tasks-core** (`plugins/tasks/plugins/tasks-core/server/index.ts`): import the view
objects and add them to the existing `contributions` array; remove the `defineView`
calls from `server/internal/views.ts`.

```ts
import { attempts, conversations, tasks } from "./internal/views";
import { View } from "@plugins/database/plugins/derived-views/server";
// ...
contributions: [
  Resource.Declare(tasksResource, { bootCritical: true }), /* ...existing... */
  View({ view: attempts }), View({ view: conversations }), View({ view: tasks }),
],
```

**agents** (`plugins/conversations/plugins/agents/server/index.ts`): the barrel already
re-exports `agents` from `./internal/views`; add `View({ view: agents })` to its existing
`contributions` array and remove the `defineView` call from its `views.ts`.

`views.ts` in both plugins loses the `defineView(...)` lines and the
`import { defineView } ...`; the `pgView(...)` definitions stay exactly where they are —
so the `db-schema` docgen facet (content-scans `server/**` for `pgView(`) is untouched,
and every existing query site importing from `./internal/views` is unchanged.

### 5. Docs

- Update `plugins/database/plugins/derived-views/CLAUDE.md` "How it works" / "To change a
  view" sections: views are declared via `View({ view })` in the owning plugin's server
  `contributions`, not a `defineView` side-effect; the AUTOGEN block + `docs/plugins-*.md`
  regenerate via `./equin build`.

## Files touched

- `plugins/database/plugins/derived-views/server/internal/contribution.ts` — **new** (token)
- `plugins/database/plugins/derived-views/server/index.ts` — export `View`
- `plugins/database/plugins/derived-views/server/internal/rebuild.ts` — read `View.getContributions()`
- `plugins/database/plugins/derived-views/core/internal/registry.ts` — drop array/`defineView`/`getRegisteredViews`, keep `RegisteredView`
- `plugins/database/plugins/derived-views/core/index.ts` — drop removed exports
- `plugins/tasks/plugins/tasks-core/server/index.ts` — add `View(...)` contributions
- `plugins/tasks/plugins/tasks-core/server/internal/views.ts` — remove `defineView` calls + import
- `plugins/conversations/plugins/agents/server/index.ts` — add `View(...)` contribution
- `plugins/conversations/plugins/agents/server/internal/views.ts` — remove `defineView` call + import
- `plugins/database/plugins/derived-views/CLAUDE.md` — prose update

No new dir, codegen, generated file, check, boundary-config, or tsconfig changes.

## Verification

1. `./equin build` — regenerates migrations (should be **none** for views), rebuilds
   server, regenerates docs. Build must pass `./equin check` (type-check,
   plugins-doc-in-sync after the CLAUDE.md edit).
2. Confirm views exist after boot:
   `query_db("SELECT viewname FROM pg_views WHERE schemaname='public' ORDER BY viewname")`
   → expect `agents_v`, `attempts_v`, `conversations_v`, `tasks_v`.
3. Sanity-query each derived view (e.g. `SELECT count(*) FROM tasks_v`) to confirm the
   relations are real and queryable — this is the exact failure the old footgun caused.
4. Grep guard: `rg 'defineView|getRegisteredViews' plugins` returns nothing outside
   research docs — the side-effect API is fully gone.
5. Open the app at `http://<worktree>.localhost:9000` and load the Tasks + Agents views
   (which read `tasks_v` / `agents_v`) to confirm no missing-relation errors.

## Optional follow-up (not in this plan)

A containment check (`every pgView( under a plugin's server/ has a matching View(...)
contribution`) would close the residual "forgot to list it" gap. Deferred because (a) no
other server contribution has such a guard, keeping the model consistent, and (b) a
robust static version needs import resolution to map `pgView` names to `View({view})`
args. Revisit only if the omission actually bites.
