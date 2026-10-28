# Demo data owned by the demo, written by the apps' fixture writers through the real write path (v2)

Track: wiki subtrack "portable server code (server/ vs machine/)" (block-323b766d-…), first item of "[Framework] Adding an app to the demo is (almost) no manual work".

v1 (`2026-10-28-global-per-app-demo-seeds.md`) put each app's demo data in a `demo-seed/` folder inside the app. The user rejected that: demo data does not belong to an app, and a second demo with other data must be possible. v2 splits the two concerns.

- **A demo owns its data.** That covers the story, the pages, the prototypes, and the order things happen in. Two demos are two plugins with two data sets.
- **An app owns its fixture format and writer.** This is a typed description of "some pages" or "some prototypes" in the app's terms, plus the function that writes it through the app's real write path. Any demo, and any test, can reuse it.

## Context

The demo's browser host seeds from `apps/agent-manager/plugins/demo/bin/seed.ts` and `bin/seed-prototypes.ts` (D below). This has four problems.

1. **The seed runs before triggers exist.** It runs before `runPostReadyPhases`, which is where trigger sync and `JobQueue.start` happen. So it calls `reindexPage` and `reindexPageSearch` by hand.
2. **It copies private formats.** It copies agent-access's private `applySummary` and stamps authors by hand.
3. **It writes app internals directly.** It writes the internals of Pages (forest rows, tags, stars) and of Prototypes (files layout, history adoption, checkpoints, picks, tag and state rows, thumbnail cache). A second demo would have to copy all of that again.
4. **The demo lives under the agent-manager app folder**, even though it shows three apps and is the website's demo.

## Design

### 1. Demos live in the website app; one plugin per demo

There is no new top-level plugin (user decision). Demos sit under the website app, whose landing band the demo is headed for. They live in `apps/website/plugins/demos/`, a small umbrella in which each child is one demo with its own data:

- `apps/website/plugins/demos/plugins/lumen/`: today's D, moved and renamed for its story (a notes app called Lumen). It holds:
  - `core`: the `DemoScenario` export (`lumenDemo`), ids, stories, the page tree, transcripts;
  - `bin/`: the browser host, its composition, the seed;
  - `data/`: prototype files and thumbnails;
  - `exhibits/` and `check/`.
- The importers change: `apps/demo/shell`'s `demo-layout.tsx` (the temporary `/demo` sandbox frame keeps rendering it until the frame moves into a website landing band) and the exhibit.
- The composition `agent-manager-demo` keeps its id, or is renamed `lumen-demo` (cosmetic, decided while implementing).
- A second demo is a sibling plugin: its own `data/`, `bin/browser-host.composition.ts` (codegen discovers hosts by that file, anywhere) and seed. **No app folder changes.**

### 2. Apps own fixture writers

Each fixture writer is a portable plugin under its app. Its `core` holds the fixture type and its pure parsing. Its `server` holds the writer.

| Writer | Fixture (core) | Writes through (server) |
|---|---|---|
| `apps/pages/plugins/fixtures` | `PageTreeFixture`: a tree of pages and content blocks with ids, tags and star (today's `DemoPage` / `DemoNode`, generalised) | `writePageTree(fixture)` does three things: `applyPageBlockPatch(null, forest)` (emits `blocksChanged`, so links, search and history derive themselves), `resolveTagNames` + `writeResolvedPageTags`, and `setPageStarred`. It makes **no** derivation calls. |
| `apps/prototypes/plugins/fixtures` | `PrototypeTreeFixture`: the folder layout (one folder per prototype, `steps/v<N>.txt` + `steps/v<N>/`, `_picks/`), its parser and version fingerprints (today's `D/core/internal/prototypes.ts`). Plus tags and pin. | `writePrototypeFixture(fixture, thumbnails)` writes, in order: (1) the thumbnail cache, (2) each folder's `v0`, (3) waits for the files watcher, which **adopts** each history (the real path), (4) each step as `history.checkpoint({ kind: "turn" })`, (5) picks, (6) tag and state rows. |

The thumbnail check and render script become generic over any fixture directory:

- **Check.** `prototypeFixtureThumbnailsCheck(dir)` is exported for checks. Each demo's `check/index.ts` is one line naming its own `data/prototypes`.
- **Script.** `scripts/render-fixture-thumbnails.ts --fixture <dir>` moves into the prototypes fixtures plugin.

Both writers are `portable: true`, so they join the worker graph through the seed's imports, which is the existing rule. Neither ships seeds or data.

The agent manager's story rows stay the demo's own code for now: tasks, attempts and conversations backdated as raw rows (no mutation can backdate), plus the agents roster, queue ranks, pushes and transcripts. A shared "agent run" fixture writer is a follow-up, once a second demo needs one.

### 3. Seed with triggers live, then settle

**Boot order.** `server-core/core/browser-host.ts` changes to:

1. `bootPluginGraph`;
2. the portable assert;
3. **`runPostReadyPhases`**: trigger sync, `JobQueue.start`, LISTEN, `onAllReady`;
4. **`seed`**;
5. the request handler is returned.

The page cannot connect before step 5. Update the header comment and the option's doc.

**Settle.** The in-process queue (`infra/jobs/plugins/in-process/server/internal/memory-queue.ts`) gets `settle()`, exported from that barrel and called by the demo's seed between its steps.

- It first yields a macrotask, so rows queued by `afterCommit` land before the check.
- It then runs every pending row now, future-dated ones included. Examples are pages.history's 4 s debounce and a retry's backoff. A seed stands for "time has passed".
- It follows the cascade, including events' two-hop dispatch.
- It resolves on the `activity()` transition that empties the queue. It never polls.
- It **rejects** naming the job and error if a row ends dead.

**Visible change.** Seeded pages now get a history snapshot, because the real trigger fires.

### 4. The dark-mode agent's page work goes through the real tools

- **Split agent-access.** The handlers of `read_page`, `edit_page` and `write_agent_note` become portable functions in `page/annotations/agent-access/server`: `pageTools.read`, `pageTools.edit` and `pageTools.writeNote`, each taking `(input, { conversationId })` and returning the exact tool result. That result includes `applySummary`, author stamps, redaction and the instructions gate.
- **Move the registrations.** The `Mcp.tool(...)` registrations move to `agent-access/machine`, since MCP serves agents on the computer.
- **Blocker.** `conversations/compaction-context/server` re-exports `compactionHookEntry`, which imports `node:fs`. That export moves to its machine half.
- **What the demo's seed does.** It calls the handlers in order:
  1. `read(bugs)`
  2. `read(spec)`
  3. `edit(bugs, …card + investigation)`
  4. `writeNote(card, done)`

  It records the real inputs and outputs in the transcript's `PageSession`.
- **What this removes.** The copied `applySummary` and the hand-made `recordAgentNotesAuthor` calls are deleted.

### 5. The demo's seed, end to end

`apps/website/demos/lumen/bin/seed.ts` runs these steps in order:

1. `writePageTree(LUMEN_PAGES)`, then `settle`.
2. Stories: tasks, rows, ranks, agents, pushes, and the prompt-block origin (`promptBlock.upsert`, which keeps the backdated `demo` ids).
3. The dark-mode page work through `pageTools`, then `settle`.
4. Transcripts.
5. `writePrototypeFixture(bundled data/prototypes, thumbnails)`, then `settle`.

The data itself, cross-references included (roadmap to-dos naming stories, the Bugs prompt), all sits in `apps/website/demos/lumen/core`. That removes the stories ↔ pages cycle by construction.

## Steps

The risky ones come first.

1. **Queue settle.** Add `settle()` with unit tests: two-hop dispatch, a debounced row fast-forwarded, a cascade, a dead row rejecting, and an empty queue.
2. **Boot order.** Move the seed after `runPostReadyPhases`, against today's seed. Fix the prototypes ordering (thumbnail cache first, wait for watcher adoption) and confirm the boot test passes.
3. **Pages fixtures.** Add the `apps/pages/plugins/fixtures` plugin and switch the seed to it. The hand derivations are deleted.
4. **Prototypes fixtures.** Add the `apps/prototypes/plugins/fixtures` plugin, plus the generic check and the render script.
5. **agent-access split.** Split it, along with compaction-context, and run the dark-mode work through `pageTools`.
6. **Move D.** D moves to `apps/website/plugins/demos/plugins/lumen` (`./equin plugin move`, which rewrites every reference), and its data moves into it.
7. **Docs.**
   - The demo's CLAUDE.md gets "how to make another demo" and "how to add an app to a demo": use the app's fixture writer, or write one in the app.
   - The fixtures plugins get their own CLAUDE.md.
   - Update the server-core boot table.
8. **Wiki.** Add a status entry, reword the track item to "the demo owns its data, apps own fixture writers", tick it, and file the next task.

## Verification

- `./equin test`:
  - the settle tests;
  - the fixture writers' own tests, which boot the portable closure on PGlite the way task-category's `portable-boot.test.ts` does. For a written page tree they check the backlinks edge, the search doc and the history snapshot. For a written prototype fixture they check the history steps, picks, tags and thumbnails.
  - the demo's `bin/browser-host.test.ts`, with the same assertions plus two new ones:
    - no `reindexPage` or `reindexPageSearch` call remains in the demo's seed;
    - the transcript's page-tool results equal the tools' output.
- `./equin check`: `boundary-rules`, `plugin-boundaries`, `portable-closure` (agent-access is now portable), `host-services:provider-placement`, the coverage guard, `plugins-registry-in-sync`, `plugins-doc-in-sync`, and the thumbnails check.
- `./equin build`, then the e2e scripts in `apps/demo/e2e` (no-leak 31/31, prototypes-in-demo 27/27, app-switch 24/24), plus a `/demo` screenshot.
- Desktop unchanged: Pages' MCP tools are still in `mcp.catalog`, and an agent `read_page` works.
- Worker ready time (warm, 3 loads) and bytes, before and after.

## Risks

- **The agent-access split** is the biggest step. If `server/` needs more than the compaction-context move, keep the current direct engine calls for the dark-mode run and file the split as its own task.
- **Watcher wait.** Waiting for the prototypes watcher is prototypes-specific, and stays inside its own fixture writer.
