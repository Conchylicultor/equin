# usage

Claude usage, counted from the transcripts on disk into the one token ledger
(infra/claude-cli/usage-ledger — tokens, never dollars), and the
conversation-facing reads of it. A cost is always a read of the priced view
`claude_spend_hours_v` (usage-ledger/pricing): each hour at the price version
in force then. Design:
[`research/2026-11-16-global-unified-claude-cost.md`](../../../../research/2026-11-16-global-unified-claude-cost.md).

- **The one scanner.** The machine half is the only reader of
  `~/.claude/projects`, and files every transcript under a ledger source:
  `conv:<conversationId>` for an equin conversation (its resolved session
  chain plus every sub-agent, deduped across the chain), `session:<sessionId>`
  for a session equin did not launch (per-file dedup). `cli:` sources are the
  claude-cli call recorder's. Each read files the whole-token delta it counted
  (`tokenDelta` — rounded per side, so deltas telescope; negative where a
  chain re-read takes tokens back) in the statement that moves its scan state.

- **A live append costs its bytes and one write, not a re-read.** The sync
  (`machine/internal/sync.ts`) is the only writer of `conversation_usage_files`
  and the agent count — every path goes through `requestUsageSync`, serialized
  per conversation — so it holds each live conversation's file rows, agent
  count and resolved chain in memory and updates them from its own writes. Per
  transcript write: one owner lookup (`conversationsFor`, which also proves the
  conversation exists) and the write when something moved. The chain is
  re-resolved only when a write names a session the held paths do not resolve
  (an adoption). The backfill job passes no written sessions and reads
  everything from the DB.

- **Scan state.** `conversation_usage_files` (a conversation's files: offset,
  tail, and the file's hour buckets — what the next delta is taken from and
  what the history import files a pre-ledger count from; no dollars) and
  `claude_transcript_scans` (the transcripts no conversation owns: offset and
  tail only). A transcript is in at most one of the two. Both outlive their
  file, so a vanished transcript never takes tokens back.

- **A transcript is its session-relative path, not its full path**
  (`machine/internal/transcript-key.ts`: `<sessionId>.jsonl`,
  `<sessionId>/subagents/…`). Its project dir can be renamed under its rows —
  the data-root move renamed every project dir under the legacy data root
  to its new name and left `conversation_usage_files.path` (and the
  archive) on the old spelling, so a chain re-resolve counted the renamed file
  again from zero (58 transcripts on main counted twice). The sync matches
  stored rows to the files it reads by key (`rekeyStoredRows`): a row under an
  old spelling moves to the new path and continues from its offset (delta: new
  minus its buckets), a second row of a transcript already counted is deleted
  and its tokens filed back, in the write's one statement. The data migration
  `…__usage_files_one_row_per_transcript.sql` collapsed the rows already
  counted twice (the one read furthest kept).

- **The Cost column is the priced ledger's.** `conversations_ext_usage`'s
  `cost_usd`, `tokens` and `cache_read_tokens` are derived by the database
  from the conversation's `conv:` rows of `claude_spend_hours_v`
  (`server/internal/cost-triggers.ts`, the `conversations.usage.cost` trigger
  set): statement-level triggers on `claude_usage_hours` (the conversations a
  write moved), `claude_model_rates` (the conversations that used the model in
  an hour its version prices) and `claude_price_versions` (the hours from the
  earliest `effective_from` a write moved) re-aggregate under a per-conversation
  advisory lock with a guarded upsert — a price correction re-prices the
  column. Not a `derived-tables` rollup: a rollup owns its whole table and may
  read only tables, and this is an entity extension (the exposure every
  conversation list joins) whose `agent_count` the sync writes, over a view.
  `reconcileUsageCosts`, the `conversations.usage.cost-reconcile` warm-up (once
  per change of that module's code), is the repair. The `conversations.usage`
  lookup reads the same row.

- **Usage is filed under the account that spent it, when it is counted.** A
  live pass (`requestUsageSync` with written sessions) files under the account
  the conversation's runtime runs its agent on now
  (`conversationRunningAccount`; after the agent exits, the last one this
  process saw); a session's live pass under the active account; a job pass
  under `UNKNOWN_ACCOUNT`. Read as `conversations.usage.account-spend` (one
  account, one UTC month — a clock param the reader pins): the priced hours
  summed per UTC day, every source, plus `claude_account_spend_carryover` —
  the legacy dollar ledger's `unattributed` dollars (2026-11-13 → 15, per
  account and day, no tokens behind them), carried over by the data migration
  that dropped that ledger.

- **File buckets are per hour.** The fold (`foldUsageEntry`, usage-ledger's
  `core`) is always per hour. A row counted before (day buckets, no `hour`)
  keeps them on an append; a re-read from the start re-buckets them, and
  `bucketDelta` takes each vanished day bucket out of the same day's hours,
  earliest first, so re-bucketing files nothing.

- **Sessions equin did not launch** (`machine/internal/session-sync.ts`):
  source `session:<sessionId>`, a `claude_usage_sources` row (project dir,
  `is_repo`). "Equin's" = the id is in any conversation's session chain (kept
  after the conversation is deleted) or a live conversation's tail. Host
  singleton only, live and backfilled (`conversations.usage.session-backfill`,
  queued by the warm-up: every session file with no scan row or grown past it,
  one `conversations.usage.session-sync` job each, in the transcript-read lane
  the conversation sync shares). Reads go a chunk (8 MiB) at a time.

  **Adoption.** The reconciler records a launched agent's session id only once
  its transcript exists, so an equin session's first appends may be counted
  here first. The conversation wins: its sync, counting a session file for the
  first time, waits out that session's ledger-only passes (`releaseSessions`,
  a per-session mutex) and deletes the session's `counted` ledger rows, source
  and scan rows in the statement that files its own count (`writeUsage`'s
  `adopted`). A file rewritten shorter than it was read recounts its whole
  `session:` source.

- **History, imported once** (`machine/internal/history-import.ts`, the
  `conversations.usage.history-import` job, queued by the warm-up on the host
  singleton): what the scanners never read, filed with origin `imported`
  (`usageLedgerImport` — no scanner take-back reaches it) and recorded in
  `claude_usage_history_imports` in the same transaction (advisory-locked;
  a second run files nothing; a fork inherits rows and record):
  1. each conversation's `conversation_usage_files` buckets (vanished files
     included), rounded per bucket as the sync rounds its deltas, minus what
     the sync already filed under `conv:` — so the ledger's `conv:` rows equal
     the file rows from then on. A remainder hour the legacy dollar ledger
     named exactly one account for (`claude_usage_import_accounts`, copied by
     the migration that dropped it) is filed under that account — a legacy
     day bucket (00:00 of its day) when every recorded hour of that day names
     the same one — the rest under `UNKNOWN_ACCOUNT`;
  2. the legacy cost archive (`machine/internal/archive.ts`'s read-only
     `loadCostArchive` over the `sessions-<YYYY>.json` shards Stats → Cost
     banked, in price-table's `costUsageDir`), an entry only when no scanner
     covers its transcript — matched by key, under any project dir: not in
     `conversation_usage_files` nor `claude_transcript_scans`, and gone from
     disk (`transcriptsOnDisk`) — or on disk but of a session a deleted
     conversation ran. A conversation with two rows for one transcript is
     refused (the import is never taken back). Source: the conversation whose chain
     holds the session, else the entry's, else `session:<id>`; 00:00 UTC of
     each day; `UNKNOWN_ACCOUNT`; a source row (project dir, repo flag,
     archived title).
  `conversation_usage_files` is locked against writes (SHARE) for the
  transaction, so the remainder in (1) is exact against live syncs.

  **Ordering on main.** The schema group that dropped `claude_spend_hours`
  runs expand (new tables) → its claimed data migration
  (`…__usage_ledger_legacy_carryover.sql`: the carryover and the import's
  accounts, copied from the dollar ledger) → contract (the drop, deferred
  until no old backend is connected; the data migration re-runs first) at
  boot, before any job; the import job runs after, reading only what the
  migration copied — and only once `deferredContractSettled()` (database
  server barrel: this boot's deferred contract has committed, so no backend
  that matches file rows by full path is connected) answers `settled`. Once main has recorded the import,
  `claude_usage_import_accounts` and the archive shards have no reader left.

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./equin build` -->

## Plugin reference

- Description: Cost, Tokens and Agents fields on every conversation list whose rows are conversations (the usage extension's exposed fields), sorting and filtering server-side. Per-conversation usage — cost, tokens and launched sub-agents — stored in conversations_ext_usage (cost and tokens derived by database triggers from the priced token ledger, claude_spend_hours_v, for the conversation's conv: source; repaired by a warm-up once per change of that derivation) and exposed to every conversation list (LiveColumns.Expose) and read by id through the lookup-only conversations.usage collection; and what each Claude account spent per UTC day (the priced ledger's hours plus the carried-over legacy unattributed days, summed per day), served as conversations.usage.account-spend. Counting it from the transcripts is the machine half's.
- Web:
  - Contributes: `FieldPresentation.Register` "exposure:conversations_ext_usage"
  - Uses: `network/live.FieldPresentation`
- Server:
  - Contributes:
    - `live.columns.expose` "conversations ← conversations_ext_usage"
    - `db-trigger` "conversations.usage.cost"
    - `resource.declare` "conversations.usage.account-spend"
    - `resource.declare` "conversations.usage:rows"
    - `change-feed-exclusion` "claude_transcript_scans"
    - `change-feed-exclusion` "conversation_usage_files"
  - Uses:
    - `database.db`
    - `database.DbExecutor`
    - `database/db-triggers.DbTrigger`
    - `database/db-triggers.defineDbTriggers`
    - `database/sql-column.parsedJson`
    - `database/sql-column.parsedText`
    - `infra/claude-cli/usage-ledger._claudeUsageHours`
    - `infra/claude-cli/usage-ledger/pricing._claudeModelRates`
    - `infra/claude-cli/usage-ledger/pricing._claudePriceVersions`
    - `infra/claude-cli/usage-ledger/pricing.claudeSpendHoursView`
    - `infra/entity-extensions.defineExtension`
    - `infra/warmup.defineWarmup`
    - `network/live.LiveColumns`
    - `network/live.serveCollection`
    - `network/live.serveValue`
    - `tasks/tasks-core._conversations`
  - DB schema: `plugins/conversations/plugins/usage/server/internal/tables.ts`
  - Entity extension of: `tasks/tasks-core` (table `conversations_ext_usage`)
  - Exports (values):
    - `_claudeTranscriptScans`
    - `_conversationUsageExt`
    - `_conversationUsageFiles`
  - Register: `defineWarmup('conversations.usage.cost-reconcile')`
  - Resources:
    - `conversations.usage:rows` (keyed, point)
    - `conversations.usage.account-spend` (push, capped: 31)
- Machine:
  - Uses:
    - `conversations/conversation-view/jsonl-viewer/subagents.listSubagentEntries`
    - `conversations/conversation-view/jsonl-viewer/subagents.subagentDirOf`
  - Register:
    - `defineJob('conversations.usage.sync')`
    - `defineJob('conversations.usage.backfill')`
    - `defineJob('conversations.usage.session-sync')`
    - `defineJob('conversations.usage.session-backfill')`
    - `defineJob('conversations.usage.history-import')`
    - `defineWarmup('conversations.usage.backfill')`
- Core:
  - Uses:
    - `fields/float/config.floatField`
    - `fields/int/config.intField`
    - `fields/money/config.moneyField`
    - `infra/entity-extensions.defineExtensionShape`
    - `network/live.clockParam`
    - `network/live.liveCollection`
    - `network/live.liveValue`
    - `packages/list-bound.cappedList`
    - `tasks/tasks-core.conversationsEntityRef`
  - Exports (types): `AccountSpendDay`
  - Exports (values):
    - `ACCOUNT_SPEND_MONTH`
    - `claudeAccountSpend`
    - `conversationUsageById`
    - `conversationUsageShape`
- Cross-plugin:
  - Imported by:
    - `conversations/conversation-view/jsonl-viewer/transcript-stats/cost`
    - `conversations/runtime-sdk`

<!-- AUTOGENERATED:END -->
