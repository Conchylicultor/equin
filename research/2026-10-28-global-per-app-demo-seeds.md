# Per-app demo seeds, written through the real write path

Track: wiki subtrack "portable server code (server/ vs machine/)" (block-323b766d-…), first item of "[Framework] Adding an app to the demo is (almost) no manual work".

## Context

The demo's browser host (a Web Worker that boots the real portable server code on PGlite) has a single seed: `apps/agent-manager/plugins/demo/bin/seed.ts` (421 lines) plus `bin/seed-prototypes.ts`. That seed holds the data of three apps: the agent manager's stories, Pages' Lumen workspace, and Prototypes' files, history, picks, tags and thumbnails. This causes three problems.

1. **The seed runs before triggers exist.** `bootBrowserHost` calls `seed()` after the `onReadyBlocking` barrier and before `runPostReadyPhases`. Events' `syncTriggerContributions` and `JobQueue.start()` only run in `onReady`, so a `page.blocksChanged` emit matches no trigger row. The seed therefore calls `reindexPage` and `reindexPageSearch` by hand, twice.
2. **It copies private formats.** `applySummary` is copied from `page/annotations/agent-access`'s private one. The agent's page work is replayed with `readBlockAsMarkdown` / `applyMarkdownToBlock` plus a hand-made `recordAgentNotesAuthor`, and a comment argues that the tools' redaction and inert-paragraph rules are identities here.
3. **It needs a hand edit for every app.** Adding an app means editing the agent manager's seed, and the app's derived rows appear only if that seed knows to build them.

**Outcome.** Each app ships its own demo seed. Every seed runs after the host is fully up, with triggers live and the job queue running, and boot waits until the derived work has settled. Pages and Prototypes move onto this. The agent manager keeps only its stories. Adding the next app is: write `<app>/demo-seed/`, done.

## Design

### 1. A `demo-seed/` folder kind

Named `demo-seed`, not `demo`, so it cannot be confused with the existing `demo` plugins (`apps/agent-manager/plugins/demo`, `framework/browser-server/plugins/demo`).

The alternative was a contribution in a sub-plugin; a folder kind wins because it makes "the desktop runs a seed" impossible to express.

- **Folder kind.** `demo-seed` is a new runtime (barrel) folder in `framework/plugin-id/core/plugin-id.ts`.
  - It is documented: true. It is shipped: **false**. No desktop registry or composition closure ever collects it, so the desktop cannot run or ship a seed. No exclusion row is needed.
  - Its boundary row (`tooling/boundaries/core/boundary-config.ts`) allows `demo-seed` to import `demo-seed`, `server` and `core`. A seed can import its own app's portable server API and another app's demo barrel. It can never import `machine`.
  - `boundaries/no-platform-api` covers `demo-seed/`.
- **Shape.** `plugins/<app>/demo-seed/index.ts` default-exports `defineDemoSeed({ description, seed: async (ctx) => … })`.
  - `defineDemoSeed` and `DemoSeedContext` come from a new portable leaf plugin, `framework/browser-server/plugins/demo/plugins/seed` (barrels `core` and `server`).
  - The context is `{ files: DemoFiles }`: this plugin's committed `demo-seed/data/**`, as path → `string | Uint8Array`. Text is `?raw` and binary is `?inline`, decided by extension. Reading a missing path throws.
- **Collection is by rule.** Codegen (`tooling/codegen/core/browser-host-gen.ts`) emits a `hostSeeds` list into `bin/browser-host.generated.ts`. It holds every `demo-seed/index.ts` of a plugin in the host composition's bundle, in topological order of their `demo-seed → demo-seed` imports. This uses the same `topoSortPlugins` and is loud on a cycle.
  - A seed whose app is in the composition runs. A seed whose app is not in it does not.
  - Each entry carries its files as one `import.meta.glob("<plugin>/demo-seed/data/**")` written by codegen. No plugin code ever writes a glob.
  - The seed's server imports join the worker graph through the existing rule ("the entry's own imports are roots"). The existing portable-closure guard checks them.
- **The test reads files from disk.** `bin/browser-host.test.ts` builds the same `hostSeeds` with `DemoFiles` read from disk, by the same `<plugin>/demo-seed/data` rule. This sits beside the existing `diskMigrations` / `diskGitLayer` swaps. The seed function takes no data argument any more.
- **Runner.** A runner in `framework/browser-server/demo/seed/server`, `runDemoSeeds(hostSeeds)`, runs the seeds one at a time in order and settles the job queue after each one (§3). It is the `seed` option D's `bin/browser-host.ts` passes, and it never names an app.

### 2. Boot order: seed with triggers live

The new sequence in `server-core/core/browser-host.ts` is:

1. `bootPluginGraph`.
2. The portable assert.
3. **`runPostReadyPhases`**: the change-feed LISTEN, `JobQueue.start`, trigger sync, then `onAllReady`.
4. **`seed`**.
5. The request handler is returned.

The page cannot connect before step 5, so nothing is served half-seeded. Update the header comment and the `seed` option's doc ("data present at boot" becomes "written as a user would, before anything is served").

Cron schedules are timers, not queue rows, so they do not muddy the settle (§3).

### 3. Queue settle: a push-based wait for derived work

Add `settle(): Promise<void>` to the in-process queue (`infra/jobs/plugins/in-process/server/internal/memory-queue.ts`) and export it from that barrel. It is the queue a browser host has; the graphile queue gets none. `server-core` cannot import jobs, which is why the runner in `framework/browser-server/demo/seed/server` calls it.

**What it does.**

- It first yields a macrotask, so that rows queued by `afterCommit` land before the check.
- While rows remain, it **fast-forwards** them:
  - A future-dated row runs now. Examples: pages.history's 4 s debounced snapshot, or a retry's backoff.
  - A seed stands for "time has passed", so skipping a debounce is legitimate.
  - The cascade is followed, including events' two-hop dispatch, because a handler enqueues its child before its own row is removed.
- It resolves on the `activity()` transition that empties the map. It never polls.
- It **rejects** naming the job and error if any row ends dead. A seed whose derived rows failed fails the boot, rather than showing a demo with no backlinks.
- It is not a deadline wait: an empty queue resolves at once.

Known effect: the seeded pages now get a history snapshot (pages.history's real trigger). Today the history is "empty until the first edit". The new behaviour is the real one.

### 4. Where the data goes

| What | From (D = `apps/agent-manager/plugins/demo`) | To |
|---|---|---|
| Lumen workspace: tree, ids, tags, star, the Bugs prompt text, `DARK_MODE_PAGE_WORK` | `D/core/internal/pages.ts`, `seedPages` in `D/bin/seed.ts` | `apps/pages/demo-seed/` (`index.ts`, `internal/`) |
| Prototypes: `data/prototypes`, `data/thumbnails`, `demoPrototypeSeed` / fingerprints, tags, pin | `D/data/`, `D/core/internal/prototypes.ts`, `D/bin/seed-prototypes.ts` | `apps/prototypes/demo-seed/` (+ `demo-seed/data/`) |
| `demo:prototype-thumbnails-in-sync` check, `render-demo-thumbnails.ts` | `D/check`, `D/scripts` | `apps/prototypes/check`, `apps/prototypes/scripts` (renamed `prototypes:demo-thumbnails-in-sync`) |
| Stories, agents, transcripts and their seed | `D/core/internal/{stories,transcripts}.ts`, `D/bin/seed.ts` | `D/demo-seed/` (D is in the bundle as `apps.agent-manager.demo`) |
| Scenario, `bin/browser-host*`, exhibit, codegen outputs | D | stays in D |

**The stories ↔ pages cycle is broken by inverting ownership.**

- Pages' demo owns its text, including the roadmap to-dos and the Bugs prompt, and imports nothing from the agent manager.
- `D/demo-seed` imports `apps/pages/demo-seed` and takes from it:
  - each story's task title, from the roadmap and Bugs to-dos it names;
  - the dark-mode prompt;
  - the page ids.
- The dependency then runs one way, which also gives the seed order: Pages, then the agent manager.
- The order between Prototypes and the others does not matter; with no edge between them, it is the topological order.

**The pages seed through the real path.** It does three things:

- `applyPageBlockPatch(null, forest)`, which emits `blocksChanged`;
- `resolveTagNames` + `writeResolvedPageTags`;
- `setPageStarred`.

It makes **no** calls to `reindexPage` or `reindexPageSearch`: links, search and history derive themselves.

**The dark-mode run through the real tools.**

- **Split agent-access.**
  - The handlers of `read_page`, `edit_page` and `write_agent_note` become plain portable functions in `agent-access/server`: `pageTools.read/edit/writeNote(input, { conversationId })`. Each returns the exact tool result text, with `applySummary`, author stamping, redaction, the instructions gate and the inert-paragraph rule.
  - The `Mcp.tool(...)` registrations move to `agent-access/machine`. MCP is served only to agents running on the computer, so that is where they belong.
  - `agent-access/server` becomes `portable: true`.
  - **Blocker to clear:** `conversations/compaction-context/server` re-exports `compactionHookEntry` from `hook-entry.ts`, which uses `node:fs`. That export moves to its `machine/` (or `cli`) half.
- **Calls.**
  - `D/demo-seed`'s seed calls the handlers with the dark-mode conversation id. The order is: `read(bugs)`, `read(spec)`, `edit(bugs, old → old + card + investigation)`, `writeNote(card, done)`.
  - It records the real inputs and results in the `PageSession` that `transcriptJsonl` turns into tool pairs.
  - The `card` and `investigation` ids are read from the edit's own result (`note_ids`, `created_page_ids`), the way the transcript's renderer parses them.
- **Deleted.** The copied `applySummary`, the hand `recordAgentNotesAuthor` calls, and the "identities here" comment are all removed.
- **Prompt origin.** `promptBlock.upsert` stays as is: the story's task must keep its `demo` id and backdated clock, which `createTaskFromPromptBlock` cannot give.
- **Stays raw.** The other raw inserts (attempts, conversations, agents, pushes) also stay raw, because no mutation can backdate. They emit nothing, so they are untouched by triggers.

**The prototypes seed in the new order.** The seed now runs after `onReady`, so the files watcher, the history adoption and the thumbnails sync are live. Two fixes follow from that.

- **Thumbnail cache first.** Seeding the thumbnail cache before any tree write fixes a real hazard: the no-renderer provider would otherwise decide "unavailable" on the first miss and never look again.
- **Order.**
  1. The thumbnail cache.
  2. Each folder's `v0` (`seedFiles` into `prototypesFiles`).
  3. Wait for the files watcher to settle, through a settle signal exported by `prototypes/files/server`. This is its own app's API, and it wraps the watcher's coalescer.
  4. The watcher has **adopted** each history by now, which is the real path, so the seed no longer calls `ensureHistory`. It asserts that the history exists.
  5. Each step: lay its files, then `history.checkpoint({ kind: "turn" })`, the same call the checkpoints plugin makes after an agent turn.
  6. Picks (`_picks`), then the tag and state rows.

## Steps

The risky ones come first.

1. **Queue settle.** Add `settle()` to the memory queue, with unit tests:
   - the two-hop dispatch;
   - a debounced future row is fast-forwarded;
   - a cascade;
   - a dead row rejects;
   - an empty queue resolves at once.
2. **Boot order.** Move the seed after `runPostReadyPhases`. On today's seed (unchanged otherwise), confirm that the boot test still passes. Watch for the prototypes hazards in the boot test.
3. **Folder kind `demo-seed`.** Add the vocabulary entry, the boundary row, the doc/ship policy, `no-platform-api` coverage and the plugin-boundaries grammar.
4. **Seed plugin.**
   - Add `defineDemoSeed`, `DemoFiles` and `runDemoSeeds`.
   - Codegen emits `hostSeeds` with globs and topological order.
   - The boot test gets its disk twin.
   - `bootBrowserHost`'s `seed` stays one callback, which the runner fills.
5. **Prototypes.** Move to `apps/prototypes/demo-seed` with the new order, plus the files-watcher settle signal. Move the check and the script. Move the prototype assertions of `browser-host.test.ts` (~:840–990) unchanged.
6. **Pages.** Move to `apps/pages/demo-seed`, invert the to-do and prompt ownership, and delete the hand derivations.
7. **agent-access split.** The tool logic is portable in `server/` and the MCP registrations go to `machine/`. Also do the compaction-context split. The dark-mode run goes through `pageTools`, and the copied format is deleted.
8. **Agent manager's stories.** Move them into `D/demo-seed`. D's `bin/seed*.ts` and `D/data` are deleted.
9. **Docs.** Update `D/CLAUDE.md`, the new plugins' CLAUDE.md, `framework/browser-server` and the server-core boot table. Note in the seed plugin's CLAUDE.md how to add an app: write `<app>/demo-seed/index.ts` and put the app in the composition.
10. **Wiki.** Add a status entry to the subtrack page, tick the item, and file the next task (portable retention / warm-up declarations).

## Verification

- `./equin test`:
  - the memory-queue settle tests;
  - `D/bin/browser-host.test.ts`, with the same assertions as today and these additions:
    - the backlinks edge Lumen → spec and the search docs exist **with no seed calling a derivation**. A grep-level assertion forbids `reindexPage` / `reindexPageSearch` in any `demo-seed/` folder.
    - The page-tool results in the transcript equal what the tools return (real `applySummary` fields, authors stamped).
    - Each seeded page has a history snapshot.
  - the codegen test for `hostSeeds` (topological order, only bundle members, globs);
  - the plugin-id / boundaries tests.
- `./equin check`, in particular:
  - `boundary-rules`, `plugin-boundaries`;
  - `boundaries:portable-closure` (agent-access is now portable);
  - `host-services:provider-placement`;
  - `plugins-registry-in-sync`, `plugins-doc-in-sync`;
  - `prototypes:demo-thumbnails-in-sync`;
  - the coverage guard.
- `./equin build`, then the demo e2e scripts in `apps/demo/e2e`:
  - `no-leak.ts` (31/31);
  - `prototypes-in-demo.ts` (27/27);
  - `app-switch.ts` (24/24).
  - Also take a screenshot of `/demo` (Pages sidebar, Bugs page with the card, Origin chip, prototype thumbnails).
- Desktop unchanged:
  - no `demo-seed/` module appears in the desktop server registries (`server.generated.ts` grep);
  - Pages' MCP tools are still listed in `mcp.catalog` and an agent `read_page` works (smoke).
- Measure worker ready (warm, 3 loads) and worker bytes before and after. The settle adds the derivation jobs to the seed time; expect tens of ms.

## Risks

- **The MCP / agent-access split** is the largest step. If `server/` turns out to need more than compaction-context to be portable, fall back to the current direct engine calls for the dark-mode run. File the split as its own task, and keep everything else.
- **Fast-forwarding hides a slow derivation.** Fine for a seed. Only the in-process queue has it, and only the seed runner calls it.
- **Watcher settle** for prototypes is app-specific. If a second app needs a non-job settle, generalise it into a seed "settle source" then, not now.
