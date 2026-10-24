# Pages back in the demo, and app switching inside the embed

Subtrack: *portable server code (server/ vs machine/)*, wiki page `block-323b766d-7ddf-4555-820a-80d82d6737f3`.
Previous session: `research/2026-10-22-global-worker-changelog-watermark-and-guard-v2.md` (Outcome → Open 6).

## Context

The `agent-manager-demo` composition subtracts `apps.pages.**` and `apps.prototypes.**`. Because a negative also removes every importer, the demo loses more than the Pages app:

- the task detail's **Origin** section (the page a task was launched from);
- the conversation toolbar's **Pages** column;
- `block-…` chips in transcripts (`active-data/page-link`);
- the **Pages** artifacts kind;
- the `read_page` / `edit_page` / `write_agent_note` tool renderers.

Several page plugins already run in the worker but have nothing to show: the editor, links, tags, agent notes, prompt blocks. The seed has no pages.

Decisions taken with the user (2026-10-24):

1. **The whole Pages app comes back**, not only what the agent manager imports.
2. **Prototypes stays out.** It becomes a standalone task: a generic virtual / local file-system host service that every file-based app can use (prototypes, the file explorer, …). That task is filed at the start of this session.
3. **The demo behaves like the app.** You can move between apps inside the embed, through the launcher, "Open in Pages", Expand and page chips. You do not get the "Opens outside this embed" toast for an app the demo serves.

### What a dry run of the guard showed

The run was in a throwaway clone with `apps.pages.**` and `apps.prototypes.**` added (`/tmp/dryrun/modB.log`, `armsB.log`). Filtered to Pages, the failures are:

| Failure | Read by | Fix |
|---|---|---|
| `pages-starred.all`, `PUT …/starred` | `pages/starred/web` | flip `starred/server` |
| `search.results` | `search/quick-find` | flip `search/engine/server` |
| `history.version(s)`, `POST …/restore` | `pages/history/web`, `history/dialog` | split `history/engine` |
| `host-account` | the Pages brand (`pages-workspace.tsx`) | `HostAccountSource` host service |
| `POST …/auto-icon/regenerate`, `claude-cli.calls-for` | `auto-icon/web` | auto-icon goes to `machine/`, the endpoint is `needsMachine` |
| contributions: `page-link`, `starred`, `agent-origin`, `content-search`, `pages/history`, `history/engine` | | flips and splits below |

`deps.states`, Settings, full-pane, exhibits and tag-tree all came in through Prototypes, so they drop out. Config pairing was already green.

## A. Pages' server halves become portable

The pattern is the precedent from `trash/machine`, `page/links/machine` and `change-feed/machine`:

- retention sweeps and warm-ups go to `machine/` (warm-ups never run on a browser host);
- jobs triggered by events stay portable (the in-process queue supports `runAt` and keys).

1. **Flip to `portable: true`** (their closures are clean):
   - `active-data/page-link/server`
   - `apps/pages/starred/server`
   - `search/engine/server`
2. **`apps/pages/agent-origin`:**
   - Move `server/internal/sweep.ts` to `machine/` (new `machine/index.ts`, `register: [agentPagesSweep]`, reading `pageBlocksOrigin.table` through its own server barrel).
   - The server keeps `LiveColumns.Expose` and `BlockLifecycle.AfterCreate`, and becomes portable.
   - This is required: the sidebar config filters on `origin` (Private, Scratch, Recent).
3. **`history/engine`:**
   - `entityVersionsRetention` goes to `machine/`.
   - The server exports `_entityVersions` (as `trash` does) and becomes portable.
   - `apps/pages/history/server` then flips as well.
4. **`apps/pages/content-search`:**
   - In `reindex-page.ts`, `node:crypto` becomes `sha256Hex` (`packages/string-hash/core`). The digest is byte-identical, so no reindex churn.
   - `backfill-warmup.ts` goes to `machine/`.
   - The two jobs stay portable, and `reindexPageSearch` is exported for the seed.
   - Delete `exempt/index.ts`, then flip.
5. **`apps/pages/auto-icon`** is model-driven, so it moves almost entirely to `machine/`:
   - jobs, the backfill and its warm-up, `generate-icon`, the `Trigger(blocksChanged)`, and the route through `implementMachine`;
   - `server/` keeps only `tables.ts` (drizzle discovery) as a portable barrel;
   - `regeneratePageIcon` gains `needsMachine: { feature: "Picking a page icon" }`;
   - `RegenerateIconAction` renders disabled with the message (`useMachineAvailability`);
   - claude-cli then leaves the scope. If it doesn't (an import from `machine/` counting), mark `claudeCliCallsFor` as `needsMachine`.
6. **`infra/host-account`** becomes a host service, so the Pages brand renders in the demo as it does on the desktop:
   - `HostAccountSource = defineHostService<{ read(): Promise<HostAccount> }>` in a portable `server/`, which serves `hostAccount` through it.
   - `host-account/machine` provides it (`read-account.ts`, `parse.ts`, `node:os`, `process`). `hostHome` moves there too, as `needsMachine: { feature: "Your home folder" }`; its only consumer, the file explorer, handles `unavailable` (tsc lists the sites).
   - New `infra/host-account/plugins/guest/server` (portable) provides a fixed demo account.
   - Add `!infra.host-account.guest.**` to `base-exclusions`, and its row to `config.test.ts`'s provider list.
   - Delete `host-account/exempt`.
7. `page/attachment-block`, `page/cover` and `annotations/agent-access` already pass the guard and are not touched. The real MCP tools are not needed, because transcripts are recorded.

## B. The composition

- `agent-manager-demo` becomes `extends: ["agent-manager", "pages"]` (the `pages` app composition is `apps.pages.**`).
  - It drops `!apps.pages.**` and keeps `!apps.prototypes.**`.
  - The demo still only subtracts, so a plugin Pages gains reaches the demo with no edit, and `config.test.ts`'s "every own entry is a negative" invariant holds.
  - If `extends` turns out to be single-parent in practice (codegen or `composition-closure`), fall back to a positive `apps.pages.**` and relax the test.
- Update the "for now" comments in `config.ts` and `demo/CLAUDE.md`.
- `./equin build` regenerates the generated files. Iterate until the guard is green; expect one or two rounds, because newly portable barrels can expose new gaps.
- Check which `Apps.App` entries end up in scope. The scope already holds `apps.debug.shell`, so the Debug app will appear in the launcher once switching works. Find the edge that imports it: cut it if it is accidental, keep it if Debug renders honest "not available" states.

## C. App switching inside the embed (`apps-core/app-embed`)

**Design.** `AppEmbed` holds an `{ appId, store, seq }` session instead of a fixed app.

- Its `AppNavBoundary` navigator resolves the URL with `resolveAppForPath(pathname, Apps.App.useContributions())`, which already exists in `apps-core/web`.
  - If the URL is in the same app, it calls `store.navigatePending`.
  - If it is another tab app in scope, it opens a new session: a fresh non-live `createPaneStore`, with `setBasePath(appPathFor(…))` and `seedPending`. This is `makeBackgroundStore`'s recipe, and it mirrors `rebuildTabApp`, which also gives a fresh store per in-tab app swap.
  - Anything else (an out-of-scope app such as Prototypes, a surface-mode app, an external link) goes to `onLeave`, which still defaults to the toast.
- The policy is the scope:
  - inside `<DemoScope>`, `<PluginScope>` already filters `Apps.App` to the composition;
  - nothing names the demo;
  - `DemoLayout` and the exhibit get switching with no change.
- `Theme name={appThemeScope(session.appId)}` and `<SurfaceCore key={seq}>` mean the theme follows the app.
- Unchanged:
  - the URL-free invariant (non-live stores only, page history never touched);
  - no keep-alive of the previous app, as with an in-tab app swap in the real app;
  - back across an app hop is out of scope (no app chrome has an in-memory back).
- Replace the `inApp !== path || basePath === "/"` special case, which `resolveAppForPath` subsumes.

**Leaks to fix in the same change.** These can drive the host's real tabs from inside the embed, and the demo has them:

1. `tabs/web/internal/use-activate-app.ts`: check the `boundary` before the `surfaceMode` branch.
2. `primitives/pane/web/pane.ts`: `openPaneImpl` sends a route stranded from `useBack` / `useOpenPane` straight to `navigateApp`. The hooks should pass `useAppNavigator() ?? navigateApp`; the imperative `openPane` keeps the live store.
3. Free `appLink(…).open()` / `appLinkProps(…)` inside React code:
   - `config_v2/config-link/web/internal/use-config-link.ts:57`
   - `primitives/launch/investigate/…/investigate-action.tsx:183`

   Both move to `useAppLink` / `useAppLinkProps`. A lint rule in `tabs/lint`, `no-free-app-nav-in-react`, bans the free forms inside components and hooks (rung 3); non-React callers stay legal.

**Tests** (`app-embed/web/__tests__/app-embed.test.tsx`, which already has the harness):

- swap to app B, then back;
- `window.location` never changes;
- under `<PluginScope>` without B, the navigation goes to `onLeave`;
- `data-theme-scope` follows the app;
- a surface-mode app goes to `onLeave`;
- a `useActivateApp` test in tabs;
- a `useBack` test in pane: a stranded route goes to the boundary, never to `navigateApp`.

## D. Seed: a small workspace the story touches

**Editor change.** `applyPageBlockPatch(pageId: string | null, …)` (`page/editor/server/internal/handle-patch-blocks.ts`):

- `null` means the workspace root, which `withPageForest` already supports as a `PageScope`.
- The final read-back and `notifyStructuralChange` accept null.
- The HTTP route stays string-only.
- This is the one sanctioned forest writer, so the seed needs no lint exemption.

**Ids** are stamped and carry `demo`: `block-1760000000-demo01`, … (accepted by `blockIdKind`, and the chip pattern recognises them).

**Content** is a pure `core/internal/pages.ts` tree:

| Page | Details |
|---|---|
| **Lumen** (root, starred, "In progress") | intro; a roadmap to-do list naming csv-export, offline and search-speed; an inline `[[page:…]]` link to the spec |
| ↳ **Theme & storage spec** | "the chosen theme survives a reload" |
| ↳ **Bugs** ("Bug") | the **prompt block that launched dark-mode**; the typo to-do (checked) and the flaky-picker to-do |
| **Ideas** (root) | a second root for the sidebar |

**`bin/seed.ts` call sequence.** It runs after the stories loop. Event triggers are synced only in `onReady`, after the seed, so nothing derived runs by itself and the seed calls the derivations directly.

1. `applyPageBlockPatch(null, { creates })`, with rows parent-first and ranks from `Rank.nBetween`.
2. `reindexPage` (`page/links/server`) and `reindexPageSearch` for every page.
3. Tags: `resolveTagNames` + `writeResolvedPageTags`. Starred: `setPageStarred`.
4. Origin: `promptBlock.upsert(darkModeTaskId, { pageId: bugs, blockId: prompt })`. The task is filed under `PAGES_CATEGORY_ID`, which moves to a new `page/prompt/link/core` so `stories.ts` can import it (`task-link/server` is repointed to it). The prompt text, the task description and the first user turn come from one constant.
5. The agent's page work is **run, not hand-built**:
   - `readBlockAsMarkdown(spec | bugs, { meta: true })`;
   - `applyMarkdownToPage(bugs, …)` splicing an `<agent-inline>` cause card and an `<agent-page title="Dark mode investigation">` after the prompt line;
   - `applyMarkdownToBlock(card, …)`;
   - `recordAgentNotesAuthor(id, darkModeConversation)` on each created card and page.

   The results become a `PageSession` that `demoTranscriptJsonl(story, now, session)` turns into `mcp__equin__read_page` / `edit_page` / `write_agent_note` tool pairs, with the real markdown and report JSON in `applySummary`'s shape. Assistant prose names bare `block-…demo…` ids, so the chips render. The transcript is a recording of a real run, and its ids and counts cannot drift from the pages.
6. `reindexPage` again after the agent's writes.

**What the demo then shows:**

- the task detail's **Origin** chip, which opens the Bugs page;
- the prompt block's conversation chip, back to the run;
- the transcript's page tool renderers, page chips and **Pages** artifacts (spec referenced, Bugs edited, investigation page created);
- the agent-page creator chip;
- the conversation toolbar's **Pages** column;
- the whole Pages app from the launcher: sidebar with Favorites, Private and Recent, search, history (empty until the first edit), and the editor (Yjs collab over the scope transport: `fetchEndpointOver(transport)`).

## Verification

- `./equin build` is green: the coverage guard, `portable-closure`, `host-services:provider-placement`, `plugins-registry-in-sync`, `type-check`.
- `bin/browser-host.test.ts`:
  - page titles and hierarchy;
  - a `page_links` edge from Lumen to the spec;
  - the tag and the star;
  - the prompt-link row;
  - authors on the card and the agent page;
  - the transcript holds the real `read_page` text;
  - `parsePageApplyReport` parses the edit report;
  - `runSearch` finds a seeded page on PGlite (`ts_rank`, `ts_headline` and prefix tsquery untested on PGlite so far; snowball/english is in the wasm build);
  - the `hostReads` assertion picks up the new reads by itself.
- Unit tests: `app-embed`, `tabs`, and `pane` as in C; the moved auto-icon, host-account and content-search tests.
- `apps/demo/e2e/no-leak.ts` still passes 30/30. A new `apps/demo/e2e/app-switch.ts`:
  - launcher → Pages shows the sidebar with the seeded pages;
  - the Origin chip opens Bugs;
  - "Open in Pages" / Expand lands in Pages, then back to the agent manager through the launcher;
  - a typed edit in a page body persists after reopening;
  - the page path stays `/demo`, and no request reaches the real server.
- Desktop unchanged, smoke-tested through `browser_*` against this build:
  - Pages sidebar (starred, origin filters), search, version history;
  - "Regenerate icon" works;
  - the Pages brand shows the OS account;
  - the file explorer's home still resolves;
  - a restart still logs "signatures unchanged".
- Measurements: worker bytes, modules and graph nodes (today 22,986,105 B, 2,521 modules, 186 nodes), and worker ready (warm, 3 loads) against main.
- Wiki: a status and measurements entry; tick "Pages back in the demo". Add a Prototypes line pointing at the filesystem task. File the next main task (citing the page id and the track-instructions block).

## Risks

- Widening `applyPageBlockPatch` to null touches the only forest writer: doc-rank dirty marks for the root and `loadPagesBlocks(tx, [])` need checking. Fallback: an exported `createRootPage` in the editor server.
- On PGlite, `doc-store.ts`'s `FOR UPDATE` / `ON CONFLICT` and the 23503 → 404 mapping are not exercised yet. The e2e edit covers them.
- Every seeded page reads "edited just now": the writer owns timestamps and backdating is banned. Accepted.
- dark-mode moves from Improvements to the Pages category in the demo. Accepted: that is the story.

## Outcome (2026-10-24)

Every part landed. The build is green and deployed. `apps/demo/e2e/no-leak.ts` passes 30/30, and the new `apps/demo/e2e/app-switch.ts` passes 24/24 (launcher to Pages and back, the Origin chip, "Open in Pages"). Prototypes was filed as task-1792842805-6kzc6j (a generic virtual / local file-system host service).

### A. Pages' server halves
- **Flipped to `portable: true`:** `page-link`, `starred`, `search/engine`, `pages/history`.
- **Split, with the computer-bound part moved to `machine/`:**
  - `agent-origin`: the sweep.
  - `history/engine`: retention.
  - `content-search`: the backfill warm-up. `node:crypto` became `sha256Hex` (pinned equal by a test), and its exempt entry is deleted.
  - `auto-icon`: everything model-driven. `regeneratePageIcon` is `needsMachine` ("Picking a page icon").
- **`host-account`:** `HostAccountSource` is a host service.
  - Desktop: `host-account/machine` (the OS account; `hostHome` is now `needsMachine`, and the file explorer handles `unavailable`).
  - Browser: `host-account/guest` ("Alex Morgan", excluded from desktop compositions).
  - Its exempt entry is deleted.
- Claude-cli left the demo scope by itself.

### B. Composition
- `agent-manager-demo` is now `extends: ["agent-manager", "pages"]`. It still only subtracts.
- Scope: worker graph 186 → 200 nodes. Apps in the demo: Agent Manager, Pages and Debug. Debug was already in scope before this session; it now appears in the launcher.

### C. App switching inside the embed
- `AppEmbed` holds an `{ appId, store, seq }` session and resolves every navigation with `resolveAppForPath` over the scoped `Apps.App`. The session is read from a ref, so a navigator held across an await acts on the current session, not the one it rendered under (a review finding).
- **Leaks closed:**
  - `useActivateApp` checks the boundary first;
  - `openPaneImpl` takes a required `crossApp` navigator (`useBack` passes the boundary);
  - config-link and investigate now use the hook forms.
- **New lint rule** `tabs/no-free-app-nav-in-react` bans the free `navigate` / `appLink` / `appLinkProps` inside a component, a hook or any JSX, including a module-level column cell (a review finding) and namespace imports. 25 sites were converted. The Debug slow-ops trace cells became a `TraceChip` component.

### D. Seed
- `applyPageBlockPatch(null, …)` creates at the workspace root.
- **Workspace:** Lumen (starred, "In progress"), the spec, Bugs ("Bug", holding the dark-mode prompt block) and Ideas. Ids are `block-1760000000-demoNN`.
- dark-mode is filed under `PAGES_CATEGORY_ID` (new `page/prompt/link/core`), and its prompt is one constant.
- **The agent's page work is run through the real engine,** and the transcript records it: `read_page` ×2, `edit_page` (an agent card and the "Dark mode investigation" agent page) and `write_agent_note`. Authors are stamped, and links and search are reindexed directly, since triggers sync only after the seed.
- The card and agent page ids are engine-minted uuids, so they don't carry `demo`.

### Measurements
| | before | after |
|---|---|---|
| Worker bundle | 22,986,105 B, 2,521 modules | 23,105,973 B (+0.5%), 2,659 modules |
| Graph nodes | 186 | 200 |
| Worker ready (warm, 3 loads, 1-min load ~2.7) | 1.6–1.8 s (last session, loaded host) | 1.38–1.40 s (graph 1.15 s, seed 0.10 s, ready 27–33 ms) |

### Tests
- **Pass:** the touched suites, run alone or by plugin. The demo boot test passes, including its new page assertions and `search.results` on PGlite (to_tsvector, ts_rank and ts_headline work).
- **Cross-suite interference, not this branch's:** in one combined run, the page-editor DB suites and `starred` fail with "database.migration-source has no provider". `doc-rank.test.ts` (unchanged) calls `collectContributions`, which leaves an empty collected set for every later suite in the process. Each file passes alone. This is the interference recorded in last session's Open 4.
- **Desktop smoke** (this build): the Pages brand, star and Favorites, quick-find, version history, Regenerate icon enabled, the file explorer's home. No errors in the logs.

### Open
1. **Test hygiene:** a suite that calls `collectContributions` must restore the collected state, or later suites read empty providers.
2. **The demo's Debug app** is reachable from the launcher and mostly reads "not available". Decide whether the demo composition should keep it.
3. **Seeded pages read "edited just now"** (the writer owns timestamps).
4. **The page-detail column is narrow** beside the task detail in a 1400 px embed (Miller widths), and its text wraps hard.
5. **Next:** see the wiki track.
