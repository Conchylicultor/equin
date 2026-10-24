# Conversation usage columns: Cost, Tokens, Agents

## Context

The user wants to see, per conversation, how much it consumed and how many
agents it launched, in the conversation DataViews (sidebar History, the
All-conversations pane; the Queue follows in phase 2). Today neither number is
in the database. Both are derived from Claude Code's JSONL transcripts on
demand:

- Tokens: `stats/cost` parses every transcript into a file-based corpus index
  (`server/internal/usage-index.ts` `parseTranscript`). The `subagents` plugin
  folds one open conversation's sub-agent files (`readUsageSince`).
- Sub-agents: they are discovered by listing `<session>/subagents/` for the one
  open conversation (`subagentDirs` / `listSubagents`).

The lists are server-side SQL windows (`conversations.history` /
`conversations.all`, 100 rows by default, 500 max). Computing the numbers per row
would re-parse multi-MB transcripts and could not sort or filter. So the numbers
become **DB columns, maintained incrementally, exposed as contributed live
columns**.

Decisions made with the user:

- **Columns.**
  - **Cost ($)** is priced with stats/cost's own price table.
  - **Tokens** = input + output + cache-creation. Cache reads are excluded because
    they dwarf everything else and mostly measure context × turns. They are still
    stored and priced into Cost.
  - **Agents** is the number of sub-agents launched, workflow agents included.
- **Sub-agents count toward the conversation's totals.**
- **Phase 1 covers History and All-conversations. The Queue is phase 2.**

## Design

### New plugin `plugins/conversations/plugins/usage` ("conversation-usage")

It owns everything: the tables, the sync, the backfill, the columns and the
fields. all-conversations and History never name it; that is collection-consumer
separation.

### 1. One shared per-entry usage fold (`stats/plugins/cost/core`)

Extract the per-line body of `parseTranscript`
(`stats/plugins/cost/server/internal/usage-index.ts:152-250`) into a pure, exported
fold:

```ts
interface UsageFoldState { buckets: Map<string, DayBucket>; seen: Set<string> }
foldUsageEntry(state, rawLine: unknown): void   // dedup by createUniqueHash, tiered DayBucket accumulation
```

- `parseTranscript` becomes a loop over `foldUsageEntry`. Its output must stay
  byte-identical, pinned by the existing `usage-index.test.ts`.
- Move these to `cost/core` too, since they are pure: `DayBucket`, `TieredTokens`,
  `TIER_THRESHOLD` (`buckets.ts`), and `priceBucket`, `resolveModel` and
  `PriceTable` (`price-table.ts`).
- The cost server barrel exports `loadCurrentPriceTable()` and
  `onPriceTableUpdated(listener)`. The listener fires from `refresh-job.ts` after
  it saves the table.
- The web formatters `formatUsd` / `formatTokensCompact`
  (`cost/web/components/format.ts`) move to `cost/core`, so both plugins render
  numbers the same way.

Result: there is one counting and pricing rule. The Cost column can never
disagree with the Stats → Cost page.

`subagents/core`'s `foldUsageLine` (message-id dedup, no pricing) is left alone.
It feeds the live sub-agent cards. Switching it to the shared fold is a separate
follow-up, noted below.

### 2. Tables (`server/internal/tables.ts`)

**`conversationUsage`**
- Defined as `defineExtension(conversationsEntity, "usage", shape)` (infra/entity-extensions).
- The table is `conversations_ext_usage`, keyed by conversation id, with FK
  cascade and the derived `updatedAt`.
- Columns, all with a literal default of `0` so the LEFT join reads `COALESCE`:
  - `costUsd` (double)
  - `tokens` (bigint)
  - `cacheReadTokens` (bigint)
  - `agentCount` (int)
- Its `.join("usage")` is the extension join that `serveColumns` requires.

**`_conversationUsageFiles`**
- A plain pgTable. It is server-only scan state, one row per transcript file
  counted toward a conversation.
- Columns:
  - `path` (PK)
  - `conversationId` (FK cascade, indexed)
  - `kind` (`session` | `subagent`)
  - `offset` (bigint)
  - `buckets` (jsonb `DayBucket[]`)
  - `tailHashes` (jsonb, the last 64 dedup hashes)
- No collection reads it. It is marked `ExcludeFromChangeFeed` so its
  high-frequency writes skip the feed.

### 3. Sync: `syncConversationUsage(conversationId)` (`server/internal/sync.ts`)

There is one code path for live appends and for the backfill.

1. **Resolve the conversation's files.**
   - Session files come from `resolveConversationTranscriptPaths(id)`
     (transcript-watcher). It returns the anchored chain, so a foreign session
     can never be counted.
   - Sub-agent and workflow-agent files come from `listSubagents(subagentDirs(id))`.
   - The subagents server barrel must newly export `subagentDirs`, `listSubagents`
     and `subagentDirOf`.
2. **Load this conversation's file rows.**
3. **Choose between a full and an incremental pass.**
   - **New file:** if a resolved file has no row and it is a *session* file, run a
     full pass. A resumed or forked session's new file copies prior history, so
     cross-file dedup needs one seen-set over the whole chain. Re-read every
     session file from 0, in chain order, through one `UsageFoldState`.
   - **Otherwise, incremental:** for each file, read the bytes from `offset` to the
     current size, stopping at the last newline. A torn trailing line is left for
     next time, and a file that shrank restarts from 0. This is the same
     mechanics as subagents' `readUsageSince`, which is generalised and moved
     beside this code. Seed `seen` with `tailHashes`: the duplicate lines of one
     message are adjacent, so a bounded tail is enough across restarts.
4. **Write.**
   - Upsert the changed file rows.
   - Recompute the conversation row from all its file rows: sum the buckets, price
     them with `loadCurrentPriceTable()` + `priceBucket`, and set
     `agentCount = count(kind = subagent)`.
   - Write it **only if a value changed**. A byte-identical result writes nothing,
     so no feed traffic.
5. **Dedupe concurrent calls.** Wrap the whole thing in `createInflight()`
   (`packages/inflight`) keyed by conversation id, so a burst of appends collapses
   onto one run plus one trailing run.

### 4. Live trigger

- Generalise transcript-watcher's `onSessionTranscriptWritten`
  (`server/internal/session-writes.ts`). Today it fires for session files only; it
  becomes `onTranscriptWritten({ path, sessionId, kind })`, also firing for
  `<sessionId>/subagents/**/agent-*.jsonl`, with the parent session id parsed from
  the path.
  - It is the same single watcher; no second subscription is added.
  - Existing callers keep their session-only behaviour by filtering on `kind`.
- The usage plugin subscribes and maps session id → conversation ids.
  - The mapping uses a new session-chain export, `conversationsForSession(sessionId)`:
    `conversation_sessions` by `claude_session_id`, plus the
    `conversations.claude_session_id` fallback.
  - It then calls `syncConversationUsage` for each one; the anchored-chain check in
    step 1 is the ownership guard.
- It runs in **every backend**, the same scope as the watcher.
  - A worktree DB is forked with `conversation_usage_files` offsets, so a worktree
    only catches up on the bytes appended since its fork.
  - This also makes the feature verifiable in the worktree before push.

### 5. Backfill and repricing (`server/internal/jobs.ts`)

**`conversations.usage.backfill`**
- A singleton job, enqueued at boot by a warmup. The pattern to copy is
  `apps/plugins/pages/plugins/auto-icon/server/internal/backfill.ts`.
- It pages through conversations that have no `conversations_ext_usage` row and
  syncs each one, with a concurrency limit of 4.
- It is idempotent and resumable.
- Main pays the full scan once. Worktrees forked afterwards inherit the result.

**`conversations.usage.reprice`**
- Enqueued from `onPriceTableUpdated`.
- It recomputes `costUsd` for every conversation row from the stored buckets. That
  is pure DB work with no file reads. The archive stays re-priceable, the same
  principle as cost's `buckets.ts`.

### 6. Columns on the collections

- `all-conversations/core/internal/collection.ts`: add `contributed: true` to both
  `allConversations` and `conversationHistory`. It is type-legal next to
  `columnScope` (`live-collection.ts:288,297`).
- `usage/core`: one `liveColumns` handle per collection, named `"usage"`.
  - Row: `{ costUsd: number, tokens: number, agentCount: number }`.
  - `filterable`: `liveNumber()` for each field.
  - `sortable`: all three.
- `usage/server`: `LiveColumns.Serve(serveColumns(handle, { join: conversationUsage.join("usage") }))`
  for each handle. The `live:contributed-columns-served` check pins this.
- Routing comes for free:
  - A usage write refills only that conversation's row, in windows that hold it
    (value role).
  - It re-decides membership only in tuples that sort or filter by a usage column.

### 7. Fields (web)

- **Slots.** all-conversations web declares a per-consumer field-extension slot
  `ConversationListFields = defineFieldExtensions<ConversationListRow>("conversations.list.fields")`.
  The All-conversations `<DataView>` passes it as `fieldExtensions`. The History
  source passes the same slot through its render bundle.
  - Verify that `MergedDataView`'s source bundle accepts `fieldExtensions`. If it
    does not, add that, since it is the generic seam.
- **Fields.** The usage web plugin contributes one component per surface. Each
  renders three `FieldDef`s that read `handle.read(row)` and bind `column:
  handle.column(...)`, the Sonata `playback-fields.tsx` pattern:
  - **Cost:** `formatUsd`, end-aligned.
  - **Tokens:** `type: "int"`, `formatTokensCompact`.
  - **Agents:** `type: "int"`.
- **Where they show.** The sidebar list renders rows through
  `SidebarConversationItem`, so the fields appear only in the table view, the
  toolbar and the sort and filter pills. The sidebar row itself is unchanged.
- **The Queue is untouched.** It does not receive the slot in phase 1, because
  its in-memory rows carry no `$columns`.

### Phase 2 (not in this change): Queue

Queue rows are full `Conversation`s built from three live resources
(`use-queue-rows.ts`), filtered and sorted in memory, and aggregated per task.

- Add a generic row-enrichment seam: a contributed per-id value, joined in
  `useQueueRows` like `queueRanks`.
- The usage plugin serves a lookup-by-id collection over `conversations_ext_usage`.
- Task groups sum their members' values.

## Performance

| Path | Cost |
|---|---|
| List read | One LEFT join on a PK, over ≤500 rows. Negligible. |
| Live append | The watcher event already exists. Then a stat of the chain's files, plus a read of only the appended bytes (KB). The inflight dedupe collapses bursts. A DB write happens only when totals change, roughly once per assistant message. |
| Feed | One routed row refill per write, only in windows holding that row. The file-state table is excluded from the feed. |
| New session in a chain (resume/fork) | One full re-read of that conversation's files. This is rare. |
| Backfill | A one-time full scan on main (the same order as cost's first index build), run as a background job. |
| Reprice | Pure SQL and JSON over the stored buckets, once a day at most. |

## Critical files

- `plugins/stats/plugins/cost/server/internal/{usage-index,buckets,price-table,refresh-job}.ts`, `cost/web/components/format.ts`: extract the fold, pricing and formatters into `cost/core`.
- `plugins/conversations/plugins/transcript-watcher/server/internal/session-writes.ts`: the generalised write hook.
- `plugins/conversations/plugins/session-chain/server`: `conversationsForSession`.
- `plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/subagents/server/{index.ts,internal/discovery.ts,internal/usage-read.ts}`: export discovery, and move the incremental reader into the usage plugin.
- `plugins/conversations/plugins/all-conversations/{core/internal/collection.ts,web/panes.tsx,web/index.ts}`: `contributed: true`, the `ConversationListFields` slot.
- `plugins/conversations/plugins/conversations-view/plugins/data-view/plugins/history/web/components/sidebar-history.tsx`: pass the slot.
- New: `plugins/conversations/plugins/usage/{core,server,web}`.

## Verification

1. **Tests** (`./equin test plugins/stats/plugins/cost plugins/conversations/plugins/usage`):
   - The cost suite is unchanged and green, which proves fold parity.
   - New `sync.test.ts` over fixture JSONL files covers:
     - append-only increments
     - adjacent duplicate lines of one message across a restart (tailHashes)
     - a torn trailing line
     - a file that shrank
     - a resumed session copying history: no double count
     - sub-agent and `workflows/wf_*` files counted in the totals and in `agentCount`
     - unchanged totals → no write
2. **Build** with `./equin build` (run in the background). Then use `query_db`
   on the worktree DB, once the backfill drains:
   - `conversations_ext_usage` is populated.
   - Spot-check 3 conversations' `costUsd` against the Stats → Cost sessions rows
     (`getCostSessions`). Sub-agent files make ours ≥ theirs per session; explain
     any gap.
3. **Live:** launch a short conversation that uses an `Agent` call. Watch its row
   in the All-conversations table: Tokens and Cost grow per turn, and Agents goes
   to 1.
4. **UI:** take a `screenshot.ts --path <all-conversations route>` with the table
   sorted by Cost descending, plus a filter of Agents > 0 in the sidebar History.
5. **Perf:** during an active agent, check `get_runtime_profile` / `get_timeline`.
   There should be no new hot path, and the usage writes should be at most about
   one per assistant message.

## Follow-ups

- Phase 2: the Queue (above).
- Have `subagents` sub-agent cards use the shared `foldUsageEntry`, so the
  per-sub-agent tokens match the column.
