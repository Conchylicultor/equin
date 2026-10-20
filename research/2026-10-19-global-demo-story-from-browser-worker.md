# The demo's story from the browser worker: tasks, attempts, conversations and transcript, with no pack

Track: "Track: apps running in the browser" (`block-d04c6c0d-…`) → subtrack "portable server code
(server/ vs machine/)" (`block-323b766d-7ddf-4555-820a-80d82d6737f3`), task row "[Slice] Tasks,
attempts and conversations from the worker seed; the pack and page server deleted". Previous slice:
`2026-10-19-global-browser-worker-host-on-pglite.md`.

## As built (2026-10-19) — where the implementation departs from the design below

- **The transcript FORMAT moved, not just the parser.** `transcript-source` holds the
  format (`core/`, moved whole from `transcript-watcher/core`, 120 importers rewritten),
  the parser and `transcriptChainReads` (`server/`, portable), and the service.
  Putting the parser in a library that imports `transcript-watcher/core` closed a
  plugin-level cycle with `transcript-watcher/server` → parser (R6 counts core
  edges in the server graph), so the format now sits BELOW the watcher.
  `transcript-watcher/server` keeps its file reads (non-portable, its existing
  debt) and its `machine/` provides `TranscriptSource`. `jsonl-viewer/server` is
  portable over the service.
- **The service is event-level** (`signature` / `events` / `watch` with
  `{ events, signature }` snapshots), so the desktop keeps its prime-on-watch
  path unchanged; the memory provider parses its JSONL with the same parser.
- **git-read-cache flagged `portable`** instead of moving `createSignedMemo` (its
  barrel was already only the two pure memos).
- **attempt-work**: only the live value moved to `attempt-work/machine`; the git
  reads stay in `server/` (non-portable, used by machine-bound callers). The
  drop entry hides when unavailable (Close covers it); the Push button offers a
  plain Close with the reason as its tooltip; the commits chip is a muted `—`.
- **Seed**: attempts and conversations are inserted as rows (backdated; no
  mutation takes timestamps), tasks / categories / pushes / ranks through the
  real functions. Tasks still read "just now".
- **Off-plan fixes** found by the checks: `readServingSocket(argv)` takes argv
  from its two bin callers (core no longer reads `process`); the test preload
  skips the desktop's host-service providers in a process that boots its own
  graph (`BOOTS_OWN_PLUGIN_GRAPH=1`), since a provider's import closure (the
  transcript reader reaches reports, notifications, config) would otherwise be
  evaluated into it.
- **Measured**: bundle 18.7 MB, 868 repo modules, 53 plugins (was 18.6 MB, 825,
  45). Boot time not re-measured.
- **Already broken before this slice, still unanswered**: `turn-ledger.turns`,
  `data-view-custom-values`, `automations.catalog` — the next task
  (task-1792419519-67zhsh).

## Context

`/demo` boots a Web Worker running the portable server graph on PGlite
(`@browser-host/apps/plugins/agent-manager/plugins/demo`). Today the worker answers only
`task-categories` and `task-category.registry`. A page-side server sits over it: the recorded pack
plus 17 `Demo.Resource` stubs. `composeBrowserServers` lists the page first, so the page wins every
key it serves, including `tasks`. As a result the task list groups pack rows, while the categories
come from the worker's seed.

**Outcome:** every key the pack answers today comes from real server code in the worker, over seeded
rows. The pack and its machinery (`definePack`, `packAll`/`packRows`/`packWindow`/`packValue`,
`servePack`, `DemoScenario.pack`) are deleted.

**Decided with the user (2026-10-19):**
- **Pack only.** The `Demo.Resource` stubs stay page-side this session, so the page server and
  `composeBrowserServers` stay too. They serve only the stubs, and the worker owns everything else.
  The stubs move in the existing "[Hubs] config_v2" and "[Apps] … delete the per-plugin stubs" rows.
- **attempt-work is machine-only.** It is measured from git. It becomes a `needsMachine` live read,
  and the demo's push, drop and commits UI shows "not available in this version", the same way
  Launch does. There is no git stand-in.

## What the pack answers today, and where each key goes

| key | server plugin | portable today? | work |
|---|---|---|---|
| `tasks`, `attempts`, `attempt-workspaces`, `pushes`, `conversations-active` / `-system` / `-gone`, `conversations.by-id` | tasks-core | yes, already in the graph | seed only |
| `queue-ranks` | conversations-view/queue | no: imports `conversationCreated` from `conversations/server` | move the event, flag `portable`, add to the host |
| `task-source-url.by-attempt` | tasks/task-source-url | DB-only, not flagged | flag `portable`, add to the host |
| `attempt-work` | tasks/attempt-work | no: git | `needsMachine`, served from `attempt-work/machine` |
| `jsonl-events` (the transcript) | jsonl-viewer over transcript-watcher | no: files, `Bun.file`, lstat, @parcel/watcher | `TranscriptSource` host service (§3) |

## Design

### 1. The seed writes the whole story (`demo/bin/seed.ts`)

- Per story, as today: the task and its category.
- Then the attempt and its conversation, through the real tasks-core tables in one transaction, with
  explicit `createdAt` / `updatedAt` / `finishedAt` / `endedAt` computed from the story's `*Ago` at
  seed time.
  - The derived-`updatedAt` trigger is BEFORE UPDATE only, so an INSERT may set `updated_at`.
  - Task status is derived (`derivedOf`), so it follows from the rows. No status emit is needed for a
    fresh database.
  - If `createAttempt` / `insertConversation` can take the rows unchanged, use them and backdate
    nothing. They cannot set timestamps today, and adding seed-only parameters to production
    mutations is the wrong trade, so raw inserts through the exported `_attempts` /
    `_conversations` tables are the expected path.
- Queue ranks come from queue's exported `upsertRank`, in story order, with `Rank.nBetween`, as the
  pack does.
- The transcript goes into the memory transcript source (§3).
- `stories.ts` stays the single description. The pack's row-building code moves into the seed, minus
  every field the server derives (rollups, `active`, `taskTitle`, embedded attempt conversations).

### 2. queue and task-source-url become portable

- **`conversationCreated` moves to `tasks-core/server`.** That is where the `conversations` table
  and `insertConversation` already live. The event and its trigger table move together
  (`tables-created-event.ts`). The physical table name is unchanged, so no migration diff is
  expected; `migrations-in-sync` confirms it.
- The importers switch to the source barrel: conversations, improve, task-title and queue. No
  re-export is left behind.
- `queue/server` and `task-source-url/server` get `portable: true`. `boundaries:portable-closure`
  proves them; any offender it finds is fixed or reported.
- Both are added to `browser-host.plugins.ts`, and the generated graph is regenerated by the build.

### 3. The transcript: a `TranscriptSource` host service

The seam sits at "raw JSONL lines of a conversation's chain", so the real parser runs in the worker.

- **New portable plugin `conversations/plugins/transcript-source`.**
  - `server/` declares `TranscriptSource = defineHostService<{ signature(id), lines(id), watch(id,
    onChange) }>`, where `lines` is the merged chain lines `readChainLines` returns today.
  - It also holds the pure line → event parsing (`parse-jsonl.ts` minus its two `Bun.file` reads)
    and `mergeChainLines`, all moved from transcript-watcher/server.
- **Desktop provider: `transcript-watcher/machine`.**
  - Chain resolution and anchoring (`resolveConversationTranscriptPaths`), `Bun.file`, the lstat
    `transcriptChainSignature`, and `watchTranscript` (@parcel/watcher) move there.
  - It provides `TranscriptSource`. Its behaviour is unchanged: the same signature strings and the
    same priming.
  - transcript-watcher's other exports keep their homes. A file that touches the computer moves to
    machine/, per the split rule. Its machine-only consumers (status reconciler, usage) import the
    machine barrel.
- **Browser provider: `transcript-source/plugins/memory/server`.**
  - An in-memory `Map<conversationId, lines>`. The signature is a per-id version counter, and
    `watch` fires on write.
  - `seedTranscript(id, lines)` is exported for the seed.
- **`jsonl-viewer/server` goes portable.**
  - `jsonlEventsMemo` is a signed memo over `TranscriptSource.signature` / `.lines`, and
    `whileSubscribed` uses `TranscriptSource.watch`.
  - `createSignedMemo` (`git-read-cache/server/internal/signed-memo.ts`, plus `git-state-memo.ts`)
    is git-agnostic and imports only portable packages. It moves to a new
    `packages/plugins/signed-memo/core`, and every importer follows. If git-read-cache's barrel turns
    out to be portable as a whole, it is flagged instead and nothing moves.
  - `reads: transcriptChainReads` stays a declaration in jsonl-viewer. The tables exist in the worker,
    and changes there are notified through `watch`.
- **The demo transcript becomes Claude Code JSONL.** `demo/core` gets a small builder that writes the
  story's turns (user text, assistant text, tool_use / tool_result pairs, stop_reason) as JSONL
  records. The seed stores them, and the worker parses them with the real parser. That covers the
  open conversation (dark-mode). Each other story gets a two-line transcript (prompt plus one
  assistant line), so opening any conversation renders instead of failing, as it does today.

### 4. attempt-work is machine-only

- The declaration gets `needsMachine: { feature: "Comparing the branch with main" }`.
- Its server moves to `attempt-work/machine`, with `live/machine`'s `serveValue`.
- The three readers (push-and-exit, drop-and-exit, commits-chip) handle the `unavailable` arm tsc
  now adds. They use the existing `useMachineAvailability` / unavailable presentation, the same as
  the Launch button.
- Server-side callers of `getAttemptWork` (the exit-drop guard) are already machine, or move with
  it. Desktop behaviour is unchanged.

### 5. The pack goes away

- Delete `apps/agent-manager/plugins/demo/core/internal/pack.ts` and `DemoScenario.pack`.
- Delete the pack builders and `servePack` in `browser-server/plugins/demo/core/internal/pack.ts`
  (795 lines) and their test. `DemoMissingError` / unserved stays.
- `DemoScope` builds the page server from the `Demo.Resource` contributions alone.
  - `host` becomes the way a scenario provides its data. A scenario with no host serves only the
    stubs.
  - The composition order is unchanged: the page first, then the worker. The page no longer claims
    the story keys.
- Tests that build packs are rewritten over contributions: `demo-scope.test.tsx`,
  `config-v2.test.tsx` and hibernation's `demo-route.test.tsx`.
- Docs: the CLAUDE.md files of the demo, scope and browser-server, and the scenario's comment.

## Execution order (stop and report if a step blows up)

1. **conversationCreated move,** then `portable: true` on queue and task-source-url, then the
   `portable-closure` check.
2. **attempt-work `needsMachine`:** the machine half and the three readers. Then `type-check`.
3. **TranscriptSource:** the plugin, the parser move, the transcript-watcher machine split,
   signed-memo to packages, jsonl-viewer portable, the memory provider. Then existing tests
   (parse-jsonl, chain-signature, watcher, jsonl-events-cache).
4. **Seed:** the attempts, conversations, ranks and JSONL transcripts. Add the new plugins to the
   host list. Extend `task-category/server/internal/portable-boot.test.ts`, or add a sibling test,
   that boots the demo host's plugin list on PGlite, runs the seed, and reads `tasks` (with
   `$columns.category`), `conversations-active`, `queue-ranks` and `jsonl-events`.
5. **Delete the pack** and the pack machinery, rewrite the tests, update the docs.
6. **Close-out:**
   - `./singularity check`, then `./singularity build`, then the verification below.
   - Update the subtrack page (tick the row, status, the bundle size and boot time delta) and the
     track card.
   - File the next main task, "[Apps]: move the Demo.Resource stubs, delete the page server and
     composeBrowserServers' demo use", with the subtrack page id and the track-instructions id
     (`block-361815ed-5750-413a-b5ab-31c5dc855144`).

## Critical files

- `plugins/apps/plugins/agent-manager/plugins/demo/{bin/seed.ts,bin/browser-host.plugins.ts,core/internal/{pack,scenario,stories}.ts}`
- `plugins/framework/plugins/browser-server/plugins/demo/{core/internal/pack.ts,plugins/scope/web/components/demo-scope.tsx}`
- `plugins/conversations/server/internal/tables-created-event.ts` → `plugins/tasks/plugins/tasks-core/server/`
- `plugins/conversations/plugins/conversations-view/plugins/queue/server/index.ts`, `plugins/tasks/plugins/task-source-url/server/index.ts`
- `plugins/tasks/plugins/attempt-work/{core,server,machine}` and the readers in `conversations/plugins/conversation-view/plugins/{push-and-exit,drop-and-exit,commits-graph}/web`
- `plugins/conversations/plugins/transcript-watcher/{server,machine}`, the new `conversations/plugins/transcript-source{,/plugins/memory}`
- `plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/server/internal/jsonl-events-{cache,resource}.ts`
- `plugins/infra/plugins/git/plugins/git-read-cache/server/internal/{signed-memo,git-state-memo}.ts` → `plugins/packages/plugins/signed-memo/core`

## Verification

- **Tests:** `./singularity test` on transcript-watcher, transcript-source, jsonl-viewer, queue,
  attempt-work, browser-server/demo and task-category (including the new demo-host PGlite boot test).
- **Checks:** `boundaries:portable-closure` (queue, task-source-url, jsonl-viewer, transcript-source
  and memory are clean), `migrations-in-sync` (no diff from the event move), `type-check`.
- **In the browser,** at `http://<worktree>.localhost:9000/debug/exhibits/x/agent-manager/demo`
  (`browser_*` tools plus a screenshot):
  - The sidebar shows the queue and the done list, and the task list groups by category: Apps (3),
    Deploy, Prototypes, None.
  - The dark-mode transcript renders from the parsed JSONL.
  - Opening another conversation renders its short transcript.
  - Push, drop and the commits chip show "not available in this version".
  - The network shows no request leaving the page for a story key. The worker's boot log gives the
    timing.
- **The desktop app is unchanged:** a live conversation's transcript still streams; the queue,
  categories and the commits chip render as before at `http://<worktree>.localhost:9000`.

## Out of scope

- The `Demo.Resource` stubs, the page server and `composeBrowserServers`' demo use (next task).
- The config_v2 split.
- Writes in the demo (the change feed over `pglite.listen`).
- Persistence.
- Ambient async context.
