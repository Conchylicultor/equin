# AppEmbed + Agent Manager demo scenario (in-app demo Phase 1, step 3)

> Parent design: [`2026-10-13-global-in-app-demo-scope-v2.md`](./2026-10-13-global-in-app-demo-scope-v2.md) §4–§7.
> Built on: [`2026-10-14-global-demo-scope-and-pack.md`](./2026-10-14-global-demo-scope-and-pack.md)
> (`definePack` / `servePack`, `<DemoScope>`, `Demo.Resource` / `Demo.Route`).
> Track: **Demos and client server** (`block-3e397e42-8412-4895-b854-e620a1b4f789`).

## Context

`<DemoScope>` can point a subtree at a browser server fed by a pack, but no app can be rendered
in-process inside it:

- there is no **AppEmbed**: one app surface with its own pane store, theme scope and navigation
  boundary (cross-app navigation reads module globals: `tabsNavigator`, `appNavSink`,
  `appLinkProps`, `useActivateApp`);
- there is no **Agent Manager scenario**: nothing answers what `/agents/c/<id>` subscribes to on
  mount;
- the sidebar cannot be served at all: `conversations-active` / `-gone` / `-system` and `tasks`
  declare `exposes` (through `related: {task}` or base exposures), and the browser server's
  external arm refuses those (`serve-on.ts:689` plus the `Unfolded` type gate).

This step lands all three, plus the website band (shipping behind the §7 ship gate) and the
migration of every bare `fetchEndpoint` that fires **without a click**. Click-triggered writes stay
on the leak ledger for the next task (decided with the user).

## Design

### 1. External serve of exposing collections (`network/live/core`)

The SQL path folds every exposure **served on its host** (`LiveColumns.Expose`) into
`row.$columns[<slice>][<field>]`; an exposure not served there is not folded at all. The external
arm applies the same rule, and the browser server serves no exposure yet — so it folds none, and
every row of an exposing collection carries `$columns: {}`, exactly what the SQL path emits on a
host with no exposing extension. No special case, and no consumer ever names a contributor's slice:

- `serve-on.ts`: drop the `exposes` refusal in `compileExternalCollection`. `arms` and
  `columnScope` stay refused (nothing on the route needs them).
- `Unfolded<Row>` becomes "the loader returns the row **without** `$columns`": an external source
  answers `Omit<Row, "$columns">`, and the arm adds `$columns: {}` (the fold of zero served
  exposures) when `collection.exposes !== null`. A loader can no longer hand-write another plugin's
  slice. Exposed fields read as their derived defaults (e.g. track → `main`).
- `demo/core` `refuseFolded` (`pack.ts:153-170`) drops its `exposes` case; pack rows are typed
  without `$columns`.
- Tests: `serve-on` external tests (an exposing `all` + window served with `$columns: {}`, `arms`
  still refused); `pack.test.ts` (an exposing collection's rows parse and serve).
- **Later, native fold** (recorded on the track card): either `s.serveExposure(exposure, { rows(parentIds) })`
  on the browser server plus a JS mirror of `exposureFolds` (needs `related` to name the row field
  holding the related id in core, and one suite shared by the SQL and JS folds), or — the end
  state — the PGlite phase running the SQL fold unchanged.

### 2. `apps-core/plugins/app-embed` (web): `<AppEmbed app route onLeave? />`

Demo-agnostic: it renders on real data with no `DemoScope` around it.

- **Factor `SurfaceCore`** out of `TabSurface` (`tab-surface/web/components/tab-surface.tsx:44-75`):
  `PaneSurfaceProvider` → `SyncStatusProvider` → `UndoRedoProvider` → `SurfaceOverlayHost` →
  `renderIsolated(Apps.App, app)` + `SyncStatusIndicator`, exported from `tab-surface/web`.
  `TabSurface` keeps `TabTitleReporter` and `UndoRedoKeys`; `AppEmbed` mounts neither (no tab
  title, no second page-global `mod+z`).
- `AppEmbed`:
  - `useState(() => { const s = createPaneStore({ live: false }); s.setBasePath(base); s.seedPending(route); return s; })`
    (`primitives/pane`; a non-live store never touches `window.location` / history);
  - `<Theme name={appThemeScope(app)} surface="canvas" className="relative isolate transform-gpu size-full">`
    (`transform-gpu` makes the shadcn sidebar's `position: fixed` resolve against the embed);
  - `surfaceId={`embed:${useId()}`}`, `basePath = appPathFor(app, apps)`,
    `loadScopePrefix = loadScopePrefixFor(app._pluginId)`;
  - a `PluginErrorBoundary`; an unknown `app` id throws (loud).
- Sidebar row clicks already go through `useOpenPane()`, which resolves the context store, so they
  land in the embed's store with no change.

### 3. Navigation boundary (`AppNav`)

- **`primitives/pane/web`**: an `AppNavBoundary` context beside `appNavSink`, value
  `AppNavigator`. `useAppNavigator()` = the boundary if present, else `appNavSink.useInstalled()`.
  `usePromote` reads it instead of the sink directly (`pane.ts:~2450`).
- **`apps-core/plugins/tabs/web`**: hook forms that consult the boundary first, then the globals:
  `useNavigate()`, `useAppLinkProps(url)`; `useActivateApp()` routes through the boundary when one
  is present.
- **Migrate the call sites the route reaches**: `app-brand.tsx:32` (home button; its
  `currentRoutePath()` check reads the surface's route instead of `window.location`),
  `app-launcher.tsx:128-131`. The module-level `navigate` / `appLink` stay for non-React callers.
- **`AppEmbed` provides the boundary**: a URL under the embed's own `basePath` →
  `store.syncRouteFromUrl(path)` (stays in the embed); anything else → `onLeave(url)`, default a
  toast "Opens outside this embed". The embed never drives the host's tabs.
- Accepted: modifier-click hrefs still open on the host origin; Cmd+B and other page-global
  shortcuts still act on whichever surface the shortcut manager picks; DataView view state in
  `localStorage` is shared with the real app.

### 4. Demo answers: scenario pack vs plugin defaults

Two kinds of answers, with a clear owner each:

- **Neutral answers (any scenario)** come from the owning plugin's `Demo.Resource`, written with
  `demoResource(id, serve)` (`browser-server/demo/web`, one line per owner): the baseline model
  catalog, no ops (`op-store.in-flight.all`, `op-store.history`), machine awake, no agents / launches,
  no allow-files, Claude Code ready, no notes / preprompts / progress / turn summaries / outcome
  reports, no edited files, no sub-agents, every task on the main track, no usage stats, an empty
  plugin tree.
- **The story** (conversations, transcript, tasks, attempts, queue ranks, attempt-work, the open
  attempt's pushes) is the scenario's pack.
- **No precedence.** A key served by both still throws (kept from the previous step): nothing needs a
  pack to override a neutral answer yet. Because neutral answers come from owners, no declaration had to
  move from `shared/` to `core/`.

### 5. Scenario + pack (`apps/agent-manager/plugins/demo`)

- `DemoScenario` gains `app: string` and `route: string` (`demo/core`, `pack.ts:521`).
- `core/`: `agentManagerDemo: DemoScenario = { id: "agent-manager", app: "agent-manager", route: "/c/<CONV>", pack: () => import("./internal/pack") }`.
  The owner of the app declares its scenario, so `demo/*` never names it.
- The pack tells one story: an agent fixing a bug in a small project. One open conversation
  (header chips, a ~30-event transcript in `jsonl-events {id}` with tool calls, an edit, a test run,
  a final summary), 3–4 other queue items in different states, 2 done conversations in
  `conversations-gone` (default window + count), their tasks / attempts / queue ranks, the agent
  roster, `attempt-work` (2 ahead, 0 behind), `task-source-url.by-attempt` (none),
  `attempt-workspaces`, `turn-summaries`. Timestamps via `ago()`.
- Iterate on the running embed until no `demo-missing` remains.
- **Exhibit**: `exhibits/` with an `appExhibit` rendering
  `<DemoScope scenario={agentManagerDemo}><AppEmbed app route /></DemoScope>` in a fixed frame. That is
  the screenshot/verification surface, independent of the website.

### 6. Website band (`apps/website/plugins/landing/plugins/demo`, web)

- `Website.Section({ id: "demo", label: "Live demo", component })` → `<WebsiteBand rhythm="section">`
  → caption + fixed-height frame (~720px desktop, the embed scaled down on narrow viewports) →
  `<DemoScope><AppEmbed/></DemoScope>`. Template: `landing/plugins/story-link`.
- Key added to `config/apps/website/shell/section.jsonc` right after `screenshot`, with a line in its
  comment block.
- **Ship gate (§7 of the parent)**: the band is fine on this private instance, but must not reach a
  publicly served website while the ledger lists a reachable bare `fetchEndpoint`. Noted in the
  plugin's `CLAUDE.md` and on the track card.

### 7. Leaks: what fires without a click

- `markViewed`: already migrated (previous step).
- **Boot snapshot** is a page-level fetch that hydrates the *page* pipeline only; the scope has its
  own `NotificationsProvider`, so nothing to migrate (verify: no hydrated key bleeds in).
- Sweep the other plugins the route mounts (`review`, `active-data`, `build`, `shell`, the app
  shell's action bar) for mount-time `fetchEndpoint` / bare `fetch("/api…")`, and migrate each to
  `useFetchEndpoint()`. Recorded in the parent doc's §7 table.
- **Runtime check**: during the e2e run, the worktree server log / gateway access log shows no
  `/api/` request carrying a demo id (`CONV`, task ids are distinctive `…-demo…` ids).
- Click-triggered writes (close, reorder, queue actions, push-and-exit, notes, dependencies, …)
  stay listed in the ledger for the next task. Demo ids don't exist on the real server, so a stray
  click there fails (404) instead of mutating real data.

## As landed

- **No website band yet (decided with the user).** §6 is deferred: the equin website stays
  demo-free while the demo is prototyped. The frame lives in a temporary sandbox app,
  `apps/demo` (`/demo`, its shell's one page is `<DemoScope><AppEmbed/></DemoScope>`); when the demo
  is ready it moves into a landing band and the app is deleted.
- **Pane primitive fix.** A non-live pane store never resolved a seeded pending path
  (`handleLocationChange` returned before parsing). It now re-parses its OWN pending path on a registry
  sync, and `navigatePending` on a non-live store resolves at once — an embed's route, and a background
  tab restored before its target plugin loaded. Pinned in `pane-isolation.test.tsx`.
- **`Rank` sort keys.** The pack's `$key` text now takes a value object's text wire form (`toJSON()`).
- **Config gap (deferred, decided with the user).** The demo still answers config from code defaults,
  so a surface arranged by a committed override shows its defaults — the sidebar's DataView reads
  "No views configured" (its views live in
  `config/conversations/conversations-view/data-view/conversations-sidebar.jsonc`). Serving the
  committed layer (override ⊕ origin ⊕ `@app` scopes) in the browser needs build infrastructure (no
  build path ships `config/` to the web today); the goal is config_v2 fully supported by the browser
  server. Filed as the next task.
- **Leak check.** After mount, no server-side log carries a demo id (they appear only in the browser's
  own `live-state` client log channel). The gateway keeps no access log, so this is not a full proof.

## Files

- **New**: `apps-core/plugins/app-embed/{package.json,CLAUDE.md,web/index.ts,web/components/app-embed.tsx,web/__tests__/app-embed.test.tsx}`;
  `apps/plugins/agent-manager/plugins/demo/{package.json,CLAUDE.md,core/index.ts,core/internal/pack.ts,exhibits/index.ts}`;
  `apps/plugins/website/plugins/landing/plugins/demo/{package.json,CLAUDE.md,web/…}`;
  neutral `Demo.Resource` contributions in their owning plugins' `web/`.
- **Edited**: `network/live/core/internal/serve-on.ts` (+tests);
  `framework/browser-server/plugins/demo/core/internal/pack.ts`, `…/scope/web/components/demo-scope.tsx` (+tests);
  `apps-core/plugins/tab-surface/web` (SurfaceCore); `primitives/pane/web` (AppNavBoundary,
  `usePromote`); `apps-core/plugins/tabs/web` (hook forms); `app-launcher` (brand, launcher);
  declarations moved `shared/` → `core/`; `config/apps/website/shell/section.jsonc`; the parent
  doc's §7 table.

## Verification

- `./singularity test plugins/network/plugins/live plugins/framework/plugins/browser-server plugins/apps-core plugins/primitives/plugins/pane`:
  - external exposing collection served, `$columns` defaulted, `arms` still refused;
  - pack shadows a contributed default; two contributions on one key throw;
  - `app-embed.test.tsx` (jsdom): renders a fixture app, a row click changes the embed's route and
    not `window.location`, a cross-app navigate calls `onLeave`, Expand of a foreign-homed pane
    calls `onLeave` (not the host navigator).
- `./singularity build`, then
  - `screenshot.ts --path /website --viewport 1440x2400` (and the exhibit): the band shows the
    sidebar (queue + done) and the conversation with its transcript; no `demo-missing`;
  - click a sidebar row in the embed: the embed's route changes, the host URL does not;
  - click the launcher / another app: refused with the toast;
  - `logs/live-state.jsonl`: no demo subscription on the real socket; server log: no `/api/`
    request with a demo id after mount.
- `./singularity check`.

## Wrap-up

- Track card: tick AppEmbed, the scenario and pack, and the website band; Status updated (the
  `exposes` limit lifted; the ship gate pending on the click-triggered leaks).
- File the next main task: migrate the click-triggered `fetchEndpoint` sites the demo reaches
  (ledger), then lift the ship gate — with the page id and the track-instructions id.
