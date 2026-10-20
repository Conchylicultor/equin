# The demo's per-plugin stubs: real server code in the worker, or machine-only

Track: "Track: apps running in the browser" → subtrack "portable server code (server/ vs
machine/)" (`block-323b766d-7ddf-4555-820a-80d82d6737f3`), task row "[Apps] Split the rest of the
agent-manager demo's closure; delete the per-plugin stubs". Previous slice:
`2026-10-19-global-demo-story-from-browser-worker.md`.

## As built (2026-10-20): where the implementation departs from the design below

- **`bootBrowserHost` takes a required `onUnmatched`.** It could not import `infra/endpoints/core`
  (that would close a plugin cycle), so the demo's `browser-host.ts` passes `unmatchedApiResponse`.
- **`PortableGateInput`.** Once `GateInput` carries the unavailable arm, a hand-typed gate
  carries it too. Four callers (remote-deploy, sonata groove, theme-gallery, tweakcn) use
  `PortableGateInput = Exclude<GateInput, GateUnavailable>`. `ResourceView` renders the arm as
  a muted placeholder by default.
- **config-origin codegen reads `machine/` too** (`config-origin-gen.ts`), the same runtime pair as
  `registrations-paired`. Before this, moving `ConfigV2.Register` into `machine/` orphaned the
  generated origins.
- **11 declarations moved from `shared/` to `core/`**, so `DEMO_READS` can import them.
- **task-title**'s generator host service has a portable provider for the worker
  (`task-title/plugins/filed-titles`). The worker boot asserts every service has a provider.
- **The health rows** (Claude Code, the Agent SDK drift) show `unknown` with the "not available"
  message. The health report has no informational or hidden state.
- **Measured:** bundle 19.0 MB, 1,084 repo modules, 72 plugins (was 18.7 MB, 868, 53). Boot time
  not measured.

## Context

`/demo` runs the real portable server code in a Web Worker on PGlite (tasks, attempts,
conversations, queue, transcripts). Next to it, a page-side browser server still answers 19
hand-written `Demo.Resource` stubs and one `Demo.Route`. Each stub is a fake answer, and several of
them claim something about data that isn't there: an empty edited-files list says "clean worktree",
an empty allow-files list says "no bypass", and the status stub says "Claude Code ready". Three keys
have no answer at all and show as errors: `turn-ledger.turns` (an inline error under every
transcript), `data-view-custom-values` and `automations.catalog`.

**Outcome:** every key except config's comes either from the plugin's real `server/` code in the
worker, or from a `needsMachine` declaration that the app renders as "not available". No demo-only
code remains besides the seed and the host list.

**Decided with the user (2026-10-20):**
- **config_v2 is separate (next session).** The `config-v2` Demo.Resource stays as the ONLY
  page-side backend. That keeps DemoScope's page server, the `Demo.Resource` slot and
  `composeBrowserServers` for one more session. The config split (store seam, descriptor feed for
  the 92 server registrars) and the deletion of the page server, the slots and compose are the next
  task.
  - Until then, a plugin made portable here moves its `ConfigV2.Register` and its config reads into
    `machine/`.
- **Scope: the listed keys plus the ones the demo visibly reads.** That is the 18 stubs, spawn-failure, the hibernation
  route and the 3 unanswered keys. It also adds `task-short-titles`, `conversation-categories`,
  `tasks-auto-start` and `runtime-sdk.bundled-cli`. Latent keys (Settings, task-detail launch
  options, debug panes) are left to the coverage list (§1.4).

## Mental model (the rule every key follows)

- **The data is in the DB → portable.**
  1. Move whatever in the plugin's `server/` barrel needs the computer into a new `machine/` barrel:
     Haiku/CLI jobs, git, file watchers, retention, config registration, MCP tools, report kinds.
  2. Flag `server/` `portable: true`.
  3. Add the plugin to `browser-host.plugins.ts`.

  The real query runs on PGlite. The seed adds rows only where the story wants them.
- **The data is the computer → `needsMachine: { feature }`** on the declaration, served from
  `machine/` via `@plugins/network/plugins/live/machine`. `useLive` returns
  `{ status: "unavailable", message }` without a request, and tsc forces every reader to handle it.
  The precedent is `tasks/plugins/attempt-work`.
- **Boundary rule (verified):** `server/` may never import `machine/`. When another plugin's
  `server/` uses an API, that API stays in the non-portable `server/`, and `machine/` holds only the
  `serve*` call or the job. A machine barrel's contributions (`ConfigV2.Register`, `Trigger`,
  `ReportKind`, `served.declare`, `register`) are collected exactly like server ones
  (`server-core/core/boot-stages.ts:125`). The machine half boots after its own server half.

## 1. Framework prerequisites (first)

1. **`GateInput` gets an `unavailable` arm** (`primitives/plugins/live-state/web/resource-utils.ts`).
   - `combineResources` precedence becomes error > unavailable > loading > ready.
   - `foldResource` requires an `unavailable` handler only when the input type carries the arm
     (conditional type), so portable callers don't change.
   - `mapResource` passes the arm through.
   - This is a rung-2 fix: each needsMachine reader below then handles the arm through the helper it
     already uses, instead of narrowing by hand.
2. **`config-v2:registrations-paired` reads `machine/index.ts` too**
   (`plugins/config_v2/check/registrations-paired.ts:107`). It treats a `ConfigV2.Register` there as
   the server half, and the hint text says "server/ or machine/". Several splits below move
   `ConfigV2.Register` into `machine/`.
3. **The saved-icon registry gets a portable home.** New `plugins/ui/plugins/icons/plugins/saved-sources/server`
   (`portable: true`) holds the pure `Map`, `defineSavedIconSource`, `savedIconSources` and
   `SavedIconSource`, moved from `sprites/server/internal/saved-sources.ts`. The sprites server and
   the six registrars import it from there. It can't be a `sprites/core` export, because the type
   names `query-resource/server`'s `RoutedSource`.
4. **The coverage test.**
   - `demo/core` lists `DEMO_READS`: the declarations the demo renders, imported so a rename is a tsc
     error.
   - `demo/bin/browser-host.test.ts` asserts that each one is served by the booted host graph or
     declares `needsMachine`. The failure message is
     `"<key> is neither served by the demo host nor needsMachine"`.
   - This replaces discovering a missing key at runtime. Latent keys are added to the list when
     they become visible.
5. **`bootBrowserHost` answers unmatched `/api` with the 409 unsupported refusal.**
   - `createBrowserServer`'s private `defaultOnUnmatched` moves to `infra/endpoints/core` as
     `unmatchedApiResponse`, and both hosts use it.
   - Today the worker returns a plain 404, and only compose's 404 skipping hides that.

## 2. Portable keys (DB-backed)

For each row: move the "to machine/" column into `<plugin>/machine/index.ts`
(`MachinePluginDefinition`), export from `server/` what `machine/` needs, flag `portable: true`,
add the plugin to the host list, delete `web/internal/demo-resource.ts` and its contribution, and
run `boundaries:portable-closure`.

| key | plugin | to machine/ | seed |
|---|---|---|---|
| `conversation-notes` | conversation-view/notes | nothing | one note on a story |
| `conversation-spawn-failures` | spawn-failure | nothing | none |
| `task-tracks` | tasks/task-track | nothing | one sidequest story |
| `usage-rank` | primitives/usage-rank | retention | none |
| `outcome-reports` | tasks/outcome-report | the MCP tools (submit, instructions) | none |
| `conversation-progress` | conversation-progress | the `conversationTurnCompleted` trigger and `classifyProgressJob` (git); `pushLanded` stays | progress steps on the open story |
| `turn-summaries` | conversation-view/turn-summary | `ConfigV2.Register`, the turn-completed trigger and the Haiku job | none |
| `conversation-preprompts` | conversation-preprompt | the `conversationCreated` trigger and `recordPrepromptJob` (reaches preprompts and config); saved icons via §1.3 | none |
| `turn-ledger.turns` | conversations/turn-ledger | retention and the two `ReportKind`s; `store.ts` emits through a `defineReportSink` (`orphanedAttemptSink` pattern) that `machine/` maps to `recordReport` | none (rows exist only after a send) |
| `task-short-titles` | tasks/task-title | the Haiku jobs, the three triggers, backfill and warmup. Non-portable callers of `scheduleTaskTitleUpdate` (tasks, page link, todo link) go through a `TaskTitleGenerator` host service declared in `server/` and provided by `machine/` | short titles for the stories |
| `conversation-categories` | conversation-category | `ConfigV2.Register`, the categories config reads, the classify job, the trigger and saved icons. The 3 routes become `needsMachine` endpoints (`implementMachine`). `getItemOrder` (config) moves; `getItemMap` (DB) stays | none |
| `tasks-auto-start` | tasks/auto-start | the dropped-sweep warmup | none |
| `data-view-custom-values` | data-view/custom-columns | none. The DB half (table, value resource, the two handlers) splits into a portable child `custom-columns/plugins/values`; the config-bound `scoped-columns` stays in the parent, which imports the child. Check for a cycle with view-order before moving | none |
| `model-provider.catalog` | model-provider + catalog | `ModelCatalogSource = defineHostService` in `catalog/server` (the `PushLedger` pattern). Moving to `machine/`: the file-backed provider (catalog file, watcher, data dir), the discover job, the CLI version trigger, `modelUnrecognizedKind`, and model-provider's `ConfigV2.Register`. A new `catalog/plugins/baseline/server` provides `BASELINE_MODELS` in the worker. `getModelCatalog()` stays a sync export over the service | none |
| `agents.roster`, `agent-launches` | conversations/agents | `launchAgent` becomes `needsMachine` (`implementMachine`), and its UI handles the result. Create and update read the catalog through the service; saved icons via §1.3 | a few agents and launches tied to stories |

The hibernation route, `markViewed`, gets the same treatment:
- `markViewed` (POST `…/viewed`) becomes a portable stamp: `touchConversationViewed` returns an
  ack, served by a new portable hibernation server half in the host.
- Resume becomes a separate `needsMachine` endpoint `resumeConversation` (`ensureResumed`) in
  `hibernation/machine`. `hibernateIdleJob` stays non-portable there.
- `useMarkConversationViewed` always stamps, and calls resume only when `hibernatedAt` is set. That
  is never true in the seed, and an unavailable result is an explicit, commented no-op: there is no
  session to resume without a computer.
- The `Demo.Route` slot then has no contributor and is deleted with its test.

## 3. needsMachine keys

The declaration gets `needsMachine`, the serve moves to `machine/` (the API stays in the
non-portable `server/` when other servers import it), the stub is deleted, and each reader handles
the arm.

| key | feature | readers → UX |
|---|---|---|
| `claude-code-status` (+ `recheckClaudeCode`) | "Checking Claude Code" | Launch is already gated; the health row shows the message (informational); the drift row is hidden |
| `runtime-sdk.bundled-cli` | "Reading the bundled Claude Code version" | `use-cli-drift`: no stand-in; the row is unavailable. It already lives in `machine/` but imports `serveValue` from `live/server` (the declaration was wrong) |
| `machine.sleep` | "Reading the machine's sleep clock" | `useSleepNowForFold`: unavailable folds to `null` (unknown), which its fold already handles |
| `op-store.in-flight.all`, `op-store.history` | "Builds, tests and pushes on this machine" | Banner and chip render nothing; the open-app button is disabled with the message as its tooltip; the Debug Ops panes show the message. `_opLogOps` stays in `server/` for `stats/pushes`. On the desktop the preload is unchanged (machine declarations reach `Resource.Declare`) |
| `edited-files` | "Listing the files an agent edited" | The review section shows the message; the header chip renders nothing; file peek is unavailable. `getEditedFiles` stays in `server/` for `review/plugin-changes` |
| `allow-monitor` (allowFiles) | "Checking for guard-bypass files" | The chip renders nothing; a stated arm, not an empty list |
| `subagent-activity` (+ `subagent-transcript`) | "Watching sub-agents" | Agent tool cards render from the transcript with no running state; the band and the stat are hidden; the sub-agent pane shows the message |
| `plugin-view.tree`, `plugin-view.facets-tree` | "Reading the plugin tree" | plugin-link DECLINES (plain code spans, never pending); the Studio panes and the plugin pane show the message; config-nav shows the message |
| `automations.catalog` | "Automations" | The list and detail panes, the launch-list section and the origin options show the message, or fall back to "By hand" only. The rest of automations stays non-portable (it is config-bound until the config split) |

## 4. Close-out of the page side (this session)

- DemoScope keeps its page server with exactly one contributor (config). Its header comment and
  CLAUDE.md say why it remains, and that it goes away next session.
- Delete `demoResource()` and the 18 stub files; the `Demo.Route` slot; and
  `hibernation/web/__tests__/demo-route.test.tsx`.
- `demo-scope.test.tsx` keeps its Demo.Resource cases, which still cover config, and drops the
  route cases.

## Execution order (stop and report if a step blows up)

1. **Framework:** §1.1, §1.2, §1.3 and §1.5. Then `type-check`.
2. **Trivial portable plugins:** notes, spawn-failure, task-track, auto-start, usage-rank,
   outcome-report. Each one: closure check, host list, stub deleted.
3. **needsMachine:** machine-sleep, runtime-sdk, allow-monitor, claude-code-status, edited-files,
   op-store, subagents, plugin-view, automations.catalog.
4. **The M splits:**
   - turn-ledger first (report sink), then task-title, which depends on turn-ledger's `userTurnSent`
   - conversation-progress, turn-summary, conversation-preprompt, conversation-category
   - custom-columns values, hibernation
5. **Catalog and agents:** the model catalog host service and its baseline provider, then agents.
6. **Seed, coverage and tests:**
   - Seed additions.
   - `DEMO_READS` plus the coverage assertion in `browser-host.test.ts`.
   - Extend the PGlite boot test to read the new keys.
7. **Close-out:**
   - Run `./singularity check`, then `./singularity build`, then the verification below.
   - Update the subtrack page: tick the row, the status, the bundle size and module count, and the
     boot time.
   - File the next main task, "[Hubs] config_v2 split; delete the page server, the Demo.Resource
     slot and composeBrowserServers' demo use, moving the unserved-key and toast policy onto the
     worker transport". Give it the subtrack page id and the track-instructions id
     (`block-361815ed-5750-413a-b5ab-31c5dc855144`).

## Critical files

- The framework:
  - `primitives/plugins/live-state/web/resource-utils.ts`
  - `config_v2/check/registrations-paired.ts`
  - `framework/plugins/server-core/core/browser-host.ts`
  - `framework/plugins/browser-server/core/internal/browser-server.ts`
  - `infra/plugins/endpoints/core`
- The demo: `apps/plugins/agent-manager/plugins/demo/{bin/browser-host.plugins.ts,bin/seed.ts,bin/browser-host.test.ts,core}`.
- The demo plugin: `framework/plugins/browser-server/plugins/demo/{web/slots.ts,plugins/scope/web/components/demo-scope.tsx,plugins/scope/web/__tests__/demo-scope.test.tsx}`.
- Per key: `<plugin>/{core,shared}/…resources.ts`, `<plugin>/server/index.ts`, a new
  `<plugin>/machine/index.ts` and `<plugin>/web/internal/demo-resource.ts` (deleted). The models to
  follow are `tasks/plugins/attempt-work/{core,machine}` for needsMachine,
  `tasks/plugins/tasks-core/server/internal/push-ledger/service.ts` for a host service, and
  `tasks-core/server/internal/sweep-orphaned-attempts.ts` for a report sink.

## Verification

- **Checks:**
  - `boundaries:portable-closure` (every newly flagged plugin)
  - `config-v2:registrations-paired`
  - `plugins-registry-in-sync`
  - `migrations-in-sync`, which should show no diff (no table moves physically, and custom-columns
    values keeps the table name)
  - `type-check`
- **Tests:**
  - `./singularity test` on the demo, live-state, browser-server/demo, and the plugins split here
    (turn-ledger, task-title, catalog, hibernation, custom-columns).
  - The coverage assertion passes.
- **In the browser,** at `/debug/exhibits/x/agent-manager/demo` with `browser_*` and a screenshot:
  - no "Couldn't load the sent messages";
  - no `loader-failed` in the console;
  - the stories show notes, progress, a sidequest track, agents and short titles;
  - the edited-files and sub-agent surfaces show "not available in this version";
  - the model pickers list the baseline.
- **The desktop app is unchanged:**
  - a turn summary and a short title are still generated;
  - the categories classify;
  - edited files and the CLI drift row render;
  - op banners show.
- **Measured:** the worker bundle size, the module and plugin counts, and the boot time (on the
  subtrack page).

## Risks

- The custom-columns child split may close a cycle with `data-view/view-order`. If it does, stop and
  report.
- Agents is the largest split (L). If its closure drags in more than the catalog service and the
  launch endpoint, stop and report rather than widen.
- Splitting `automations` beyond its catalog is out of scope. If its `origin` exposure is needed by
  the task list in the demo, record it as the next row's work.
- Bundle growth from about 20 more plugin closures is unmeasured until the build.

## Out of scope

- The config_v2 split.
- Deleting the page server, the `Demo.Resource` slot and `composeBrowserServers`, and moving the
  unserved-key and toast policy (the next task).
- Latent keys beyond `DEMO_READS`.
- Writes and persistence in the demo.
