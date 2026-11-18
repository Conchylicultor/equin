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
  `<sessionId>/subagents/…`) — and that key is what both scan tables store
  in `path`, never `~/.claude/projects/<dir>/…`. Its project dir can be renamed
  under its rows: the data-root move renamed every project dir under the
  legacy data root to its new name and left the stored absolute paths (and
  the archive) on the old spelling, so a chain re-resolve counted the renamed
  file again from zero (58 transcripts on main counted twice). The scanners
  read a file by its full path and store `transcriptKey(path)`; a stored row
  is matched to the file a pass reads by key (`rekeyStoredRows`), so no rename
  of a project dir — or of the projects dir — strands a row. Bringing the
  existing rows over has to survive a hot restart, where the previous backend
  keeps writing absolute paths for a while:
  - `conversation_usage_files`: keyed at boot by the data migration
    `…__usage_scan_rows_store_transcript_keys.sql` (the previous backend
    matches these rows by key already). A row the previous backend writes
    under an absolute path afterwards moves to its key in the sync's write;
    a second row of one transcript (the less-read one) is deleted with
    nothing given back — it is one count continued under two spellings.
  - `claude_transcript_scans`: the previous backend matches these by absolute
    path, so they are keyed only once it is gone — by the
    `conversations.usage.scan-keys` job (`machine/internal/scan-keys.ts`,
    after `deferredContractSettled()`). Until then the scanners read both
    spellings and take the furthest row per transcript (`furthestByKey`),
    writing the keyed one beside it.

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

- **The cost through an hour** (`conversations.usage.cost-by-hour`, machine
  half `machine/internal/cost-by-hour.ts`): the transcript's cost stat while
  the reader is scrolled back. Keyed by `(conversation, UTC hour)`, never by
  the reading position: the value is the priced ledger's hours before the hour
  (read from `claude_spend_hours_v`) and one step per instant of the hour a
  usage line moves the cost — the hour's lines from the conversation's
  transcripts and sub-agents, in time order through one seen-set, with the
  ledger's own `foldUsageEntry` (`cost-stretch.ts`'s `costSteps`), priced with
  the rates in force at that hour (pricing's `ratesInForceAt` /
  `priceWithRates`). The stat prices its position on the client
  (`costAtInstant`), so scrolling within an hour opens no new key. Each file's
  usage lines are held per conversation (16 at most) and read incrementally.
  It follows the conversation's usage row (moved by every ledger write for it
  and every re-price) and its transcript chain. A worktree's fork reads its
  own, possibly stale, ledger for the whole hours and the live files for the
  stretch, so there it can read above the fork's total.

- **Usage is filed under the account that spent it, when it is counted.** A
  live pass (`requestUsageSync` with written sessions) files under the account
  the conversation's runtime runs its agent on now
  (`conversationRunningAccount`; after the agent exits, the last one this
  process saw); a job pass under `UNKNOWN_ACCOUNT`. A `session:` source (a
  session equin did not launch) files what its transcript says, live or job
  alike — see "Sessions equin did not launch" below. Read as `conversations.usage.account-spend` (one
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

  **Account: the transcript's `session-owner` record.** Claude Code (since
  ~2.1.319) writes `{"type":"session-owner","accountUuid","organizationUuid"}`
  in the metadata block it re-appends through a session (start, around
  turns, exit): the claude.ai login (`~/.claude.json`'s `oauthAccount`) the
  session runs on — kept for the session's life, restored on resume, written
  anew when the session moves to another login. It writes none for a session
  on `CLAUDE_CODE_OAUTH_TOKEN` (an equin added account) or an API key, nor in
  a sub-agent's transcript. Each entry is filed under the last record before
  it (`scanTranscript` cuts the count at each new owner; the scan row keeps
  `owner` across reads; a sub-agent follows its session file): the system
  account when that login is the computer's login now (accounts'
  `readSystemLogin`), else `claudeLoginAccountId(uuid)` (`claude-login:<uuid>`
  — a setup-token credential cannot read its own account uuid, so no added
  account can be matched); no record before it, `UNKNOWN_ACCOUNT`. Never the
  active account: a session equin did not launch runs on whatever its
  terminal or Claude Desktop is signed into. Rows written before owners were
  read (`owner_tracked` false) are recounted whole once (the backfill queues
  them) while all their files are on disk; with a file gone they keep what
  they filed. Whether equin launched a session stays the session-chain test,
  not the transcript's `entrypoint` (`sdk-ts` is any Agent SDK client, and
  equin's chain record is exact).

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
     the same one — the rest under `UNKNOWN_ACCOUNT` (main's import only: the
     accounts table was dropped once main recorded it; an import since files
     every remainder under `UNKNOWN_ACCOUNT`);
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
  that matches file rows by full path is connected) answers `settled`. Main
  recorded the import on 2026-11-16 (`archive-and-conversations-v1`);
  `claude_usage_import_accounts` was dropped after, and the archive shards
  are read only by an import that has not run yet (a fresh install has none).

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
    - `resource.declare` "conversations.usage.cost-by-hour"
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
    - `conversations.usage.cost-by-hour` (push, notified, capped: 20_000, capped: 64)
- Machine:
  - Uses:
    - `conversations/conversation-view/jsonl-viewer/subagents.listSubagentEntries`
    - `conversations/conversation-view/jsonl-viewer/subagents.subagentDirOf`
    - `infra/claude-cli/accounts.readSystemLogin`
    - `infra/claude-cli/accounts.SystemLogin`
    - `network/live.serveValue`
  - Register:
    - `defineJob('conversations.usage.sync')`
    - `defineJob('conversations.usage.backfill')`
    - `defineJob('conversations.usage.session-sync')`
    - `defineJob('conversations.usage.session-backfill')`
    - `defineJob('conversations.usage.history-import')`
    - `defineJob('conversations.usage.scan-keys')`
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
  - Exports (types):
    - `AccountSpendDay`
    - `ConversationCostByHour`
  - Exports (values):
    - `ACCOUNT_SPEND_MONTH`
    - `claudeAccountSpend`
    - `conversationCostByHour`
    - `conversationUsageById`
    - `conversationUsageShape`
    - `costAtInstant`
    - `hourStartOf`
- Cross-plugin:
  - Imported by:
    - `conversations/conversation-view/jsonl-viewer/transcript-stats/cost`
    - `conversations/runtime-sdk`

<!-- AUTOGENERATED:END -->
