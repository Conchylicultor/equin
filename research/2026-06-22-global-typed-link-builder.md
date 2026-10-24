# Typed link builder for notification / toast links

## Context

Notifications and toasts store `linkTo` as a free-form string, and every call site
hand-writes the full app-rooted path (e.g. `` `/agents/c/${id}` ``,
`` `/agents/build/r/${id}` ``). Nothing checks that the path's segment shape matches
the target pane, or that its prefix matches a registered app. This already shipped a
real bug: build notifications used `/build/r/<id>` (missing the `/agents` prefix), so
clicking them silently did nothing — `navigate()` resolves the owning app by
longest path-prefix and no app owns `/build`. A loud-fail throw was added to
`navigate()` as a backstop, but the underlying footgun remains for every
link-producing site.

The fix is a **typed link builder co-located with the route definition** so a link
can never be constructed with a wrong segment shape or a missing/incorrect app prefix.

### Hard constraint discovered

Links are built **server-side** too (build notifications in
`plugins/build/server/internal/run-build.ts`, conversation/report/reminder jobs), but
the pane primitive (`Pane.define`, `buildRouteUrl`, the runtime registry, the
`Apps.App` slot) is **web-only** — none of it is reachable from a server runtime. So
the link-relevant identity (the segment chain + the app base path) must live in a
**cross-runtime `core`** location.

## Design (option 2: panes stay app-agnostic)

A pane stays app-agnostic (it can appear under multiple apps; segments are globally
unique; no single owning-app on a pane). The link builder therefore takes the app
**explicitly** and is keyed off a **route descriptor** — the pure-data subset of a
pane (id + segment + parent chain) that lives in `core` and is *consumed* by the
web pane, so there is a single source of truth (no sync-check).

```ts
buildDetailRoute.link(agentManagerApp, { runId })   // → "/agents/build/r/<id>"
```

- `agentManagerApp` is a typed `AppRef` value (compile-time reference to a real app),
  not a stringly-typed id — you can't pass an app that wasn't declared via `defineApp`.
- The segment chain comes from the route descriptor, so renaming a segment or
  restructuring ancestors updates every link automatically.

### New cross-runtime primitive — `plugins/primitives/plugins/pane/core/` (new barrel)

Pure TS, no React, importable from server + web. Exports:

- `interface AppRef { id: string; basePath: string }`
- `defineApp({ id, basePath }): AppRef` — trivial factory (brand + canonical home).
- `defineRoute({ id, segment, parent? }): RouteDef<Params>` where `Params` is inferred
  from the full ancestor+own segment chain (reuse the existing `InferParams<Path>`
  helper, lifted to core). `RouteDef` exposes:
  - `id`, `segment`, `parent?`, `parentPaneIds: string[]` (root-first ancestor ids),
  - `path(params): string` → app-relative path (`/build/r/<id>`),
  - `link(app: AppRef, params): string` → `app.basePath` + `path(...)` (root app `/` → `""`).
- `fillSegment(segment, params): string[]` — the per-segment param substitution
  (`:name`, `:name*`, `encodeURIComponent`, throw on missing) **extracted from the
  existing `buildRouteUrl`** so web and core share one implementation.

`plugins/primitives/plugins/pane/web/pane.ts`:
- `buildRouteUrl` is refactored to call `fillSegment` (no duplicated encoding logic).
- `Pane.define` gains a `route` form: `Pane.define({ route, component, width?, resolve?, … })`
  derives `id`, `segment`, and `defaultAncestors` (= `route.parentPaneIds`) from the
  route; params are typed from `RouteDef<Params>`. The legacy
  `{ id, segment, defaultAncestors }` form stays for all unconverted panes.
  `PaneObject` gains `.link(app, params)` (delegates to the route) when route-backed.

No cycle: `pane/core` imports nothing external; `apps`/feature cores → `pane/core`
(correct downward direction).

### App refs (single source for base path)

Minimal `core` barrels holding only the app ref (no feature imports, so no import
cycle with the app subtrees that pull in feature plugins):

- `plugins/apps/plugins/agent-manager/plugins/shell/core/index.ts`
  → `export const agentManagerApp = defineApp({ id: "agent-manager", basePath: "/agents" })`
- `plugins/apps/plugins/pages/plugins/shell/core/index.ts`
  → `export const pagesApp = defineApp({ id: "pages", basePath: "/pages" })`

Each app's web shell reads `id`/`path` **from** its ref (single source):
- `…/agent-manager/plugins/shell/web/index.ts`: `Apps.App({ id: agentManagerApp.id, path: agentManagerApp.basePath, … })`
- `…/pages/plugins/shell/web/index.ts`: same with `pagesApp`.

### Route descriptors (one per link-target pane + ancestors)

| Route | Home (`core`) | segment | param | parent |
|---|---|---|---|---|
| `buildRoute` | `plugins/build/core` | `build` | — | — |
| `buildDetailRoute` | `plugins/build/core` | `r/:runId` | `runId` | `buildRoute` |
| `conversationRoute` | `plugins/conversations/core` | `c/:convId` | `convId` | — |
| `tasksRootRoute` | `plugins/tasks/core` | `tasks` | — | — |
| `taskDetailRoute` | `plugins/tasks/core` | `t/:taskId` | `taskId` | `tasksRootRoute` |
| `pageDetailRoute` | `plugins/apps/plugins/pages/plugins/page-tree/core` (new) | `page/:pageId` | `pageId` | — |

Convert these 6 panes to consume their route (single source):
`buildPane`, `buildDetailPane` (`build/web/panes.tsx`); `conversationPane`
(`conversations/plugins/conversation-view/web/panes.tsx`); `tasksRootPane`,
`taskDetailPane` (`tasks/plugins/task-detail/web/panes.tsx`); `pageDetailPane`
(`apps/plugins/pages/plugins/page-tree/web/panes.tsx`). Runtime id/segment/ancestors
are unchanged, so URL matching, `buildRouteUrl`, `openPane`, `useParams` are unaffected.

### Migrate the 12 link-producing sites

Server (`recordNotification`):
- `build/server/internal/run-build.ts` ×2 → `buildDetailRoute.link(agentManagerApp, { runId: buildId })` (drop the manual-prefix comment).
- `conversations/server/internal/notify-created-job.ts` → `conversationRoute.link(agentManagerApp, { convId: event.conversationId })`
- `conversations/plugins/conversation-view/plugins/push-and-exit/server/internal/exit-clean-finalize-job.ts` → `conversationRoute.link(agentManagerApp, { convId: conversationId })`
- `reports/server/internal/record-report.ts` → `outcome.taskId ? taskDetailRoute.link(agentManagerApp, { taskId: outcome.taskId }) : null`
- `page/plugins/inline-date/server/internal/fire-job.ts` → `pageDetailRoute.link(pagesApp, { pageId: row.pageId })`

Web (`toast`):
- `build/plugins/build-fix/web/components/build-fix-section.tsx`
- `apps/plugins/prototypes/plugins/gallery/web/components/prototype-detail.tsx`
- `apps/plugins/prototypes/plugins/gallery/web/components/prototype-gallery.tsx`
- `reports/plugins/launch-fix/web/components/launch-fix-button.tsx`
- `conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/investigate-event/web/components/investigate-event-button.tsx`
  → all `conversationRoute.link(agentManagerApp, { convId: conv.id })`.

### Regression guard — new `./equin check`

`plugins/framework/plugins/tooling/plugins/checks/plugins/no-hand-built-link-to/check/index.ts`
(default-export a `Check`). Uses `grepCode` to flag any hand-built app-rooted link
literal: regex `` /linkTo:\s*['"`]\// `` — matches `linkTo: "/…"` and
`` linkTo: `/…` `` while allowing `linkTo: someRoute.link(...)`, `linkTo: null`, and
variables. Message points at the builder. (Type declarations like
`linkTo?: string | null` don't match, so the schema/storage files need no allowlist.)

## Files

New: `pane/core/{index.ts,route.ts}`; two `shell/core/index.ts` (agent-manager, pages);
`pages/page-tree/core/index.ts`; route files under build/conversations/tasks cores;
the check plugin.
Modified: `pane/web/pane.ts`; 6 pane files; 2 web shell barrels; 10 link call sites.

## Verification

1. `./equin build` — regenerates registries/migrations, type-checks. The
   `route.link(app, params)` signatures make every migrated site type-checked.
2. `./equin check` — runs `type-check`, `plugin-boundaries` (asserts no cycle
   from the new edges), and the new `no-hand-built-link-to` (should pass post-migration;
   verify it fails if a literal `linkTo: "/x"` is reintroduced).
3. Manual: trigger an auto-build (push to main from another worktree) or click a
   "Build succeeded" notification → confirm it opens the build-detail pane under
   `/agents/build/r/<id>`. Click a "conversation created" notification → opens `/agents/c/<id>`.
