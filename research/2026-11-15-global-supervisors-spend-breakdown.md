# Supervisors spend breakdown

Prototype: `proto-1794509585-7ca910` (`?view=spend`, `?view=spend-drill`).

## Context

The user cannot see where their Claude quota goes. They want, on the Supervisors page:

- a quick "Spent this week" glance;
- a breakdown into four categories:
  - **Supervisors**: always-running role sessions plus their workers;
  - **Ad hoc**: supervisor-mandate tasks not owned by a role;
  - **Background**: automated Haiku calls and automations;
  - **You**: their own conversations.

Every level can be drilled, one at a time. "This week" means since the plan's weekly reset. Spend never appears on an individual supervisor's page, and there is no per-account split in the UI. The user has several accounts: subscription accounts with different weekly resets, and API-key accounts.

Amounts are **API-equivalent dollars**, the same pricing as the conversation Cost column (`stats/cost` `priceBucket`).

## What exists today

| Need | Exists | Gap |
|---|---|---|
| Cost per conversation | `conversations_ext_usage.cost_usd`, written by `syncConversationUsage` (`conversations/plugins/usage/machine/internal/sync.ts`) | Lifetime total only, with no time dimension |
| Cost per time | `conversation_usage_account_days` (account, UTC day), written by the usage sync in the same statement as the file rows; read by `claudeAccountSpend` (Settings → Accounts, spend per day of a month) | Doesn't say what spent it; a whole UTC day is too coarse for a reset at a precise time |
| Background Haiku calls | `claude_cli_calls` (`infra/claude-cli`): sourceName, model, correlationId; run on the active account | **Not tracked anywhere**: no cost is stored, `persistSession: false` leaves no transcript for `stats/cost`, and the log is trimmed to 1000 rows (about 2 days on main) |
| Cost of a CLI call | `runClaudeTurn` result (`run-claude-print.ts`): the SDK result message carries `total_cost_usd` | It is discarded |
| Token history | `stats/cost` corpus index + archive: per transcript, (UTC day, model, speed) token buckets, re-priced daily; JSON files, not the DB | A separate system (overlap tracked as a follow-up, not touched here) |
| Weekly reset | `claudeUsage` live value (`runtime-sdk/core/claude-usage.ts`): `week.resetsAt` per account | — |
| Attribution | `tasks_ext_mandate` (`mandateId`, `mandateSource` = the root stating it), `tasks_ext_supervisor` (owner role), `tasks_ext_origin` (automationId) | — |

## Design

### 1. Data capture: widen the existing account ledger (no new system)

There is **one** spend ledger. `conversation_usage_account_days (account, day)` becomes **`claude_spend_hours (account_id, hour, source, cost_usd)`**, PK (account_id, hour, source).
- **`source`** says what spent the cost: `conv:<conversationId>` for a conversation, `cli:<sourceName>` for a background call (`cli:task-title`, …). It is a plain text key, not a foreign key: an account's spend outlives the conversations that spent it, as the day table's comment already states.
- **`hour`**: the priced bucket's message timestamp truncated to the hour, in UTC. `foldUsageEntry` buckets by date; the usage scan's spend output (`AccountSpend`, `scan.ts`) gets an hour instead of a day. The token buckets of `stats/cost` keep their date key.
- **Owner:** `infra/claude-cli`, the lowest plugin both writers already reach (`conversations` imports it). It exports a query builder `spendLedgerUpsert(exec, rows)` that accumulates with `cost_usd + excluded.cost_usd`, and the table.
- **Writers, both existing paths:**
  - the usage sync's `writeUsage` (`write.ts`) swaps its account-days insert for `spendLedgerUpsert`. It is still the same `writeAtomically` statement as the file rows, so a failed write moves neither. A backfill or reprice pass still files nothing.
  - `invokeClaude` (`run-claude-print.ts`) keeps `result.total_cost_usd` (also as a nullable `costUsd` column on the call log row, for the log pane) and upserts the ledger row in the transaction that already records the call. Error results that report a cost are counted. It is written explicitly, not as a rollup over the call log, whose trim deletes rows.
- **Migration:** rename the table and keep its history. Each existing (account, day) row becomes an hour row at 00:00 UTC with `source = 'unattributed'`. The account month chart is unchanged, and the breakdown shows nothing for this history, since it can't be attributed.
- **`claudeAccountSpend`** reads the same table, summed per UTC day (`date_trunc('day', hour)`).
- **Bound:** a row per (account, active hour, source); a few thousand a month. Kept, like the day table.

### 2. Window: each account counts from its own reset

- **Subscription account:** its spend counts from its own last weekly reset, `week.resetsAt − 7 days`, read from `claudeUsage`.
- **API-key account** (no weekly quota): its spend counts over the last 7 days. It is real money, not quota. The glance includes it, and the tooltip and the row subtitles mark it as billed API usage.
- **Subscription account with no usage reading yet:** last 7 days, and the header marks the window as approximate.
- **Total and categories:** the sum across accounts, each over its own window. Hovering the total lists each account's window (`Personal: since Mon 09:00 · Work: since Thu 14:00 · API key: last 7 days`). There is still no per-account breakdown.
- The browser builds the windows from `useLive(claudeUsage)` and the account list, and passes them as a param. A served read never reads the clock.

### 3. Attribution: one server read, `supervisors.spend` (`liveValue`)

New plugin: `tasks/supervisor-roles/plugins/spend` (core + server + web).

**Params:** `{ windows: { accountId, since }[] }` (one entry per account, canonical order).

**Result:** the drill tree, each node `{ id, name, sub?, costUsd, live?, kind, children? }`.
- Every node's children are top-5 by cost plus one `rest` node `{ count, costUsd }`.
- Bound: `cappedList(max: 6)` at every level, so the whole tree is O(5⁴) at most. This is exactly what the prototype draws; its colour palette is 5 slots plus a grey "rest".

**SQL:** one query over `claude_spend_hours` joined to the windows (`hour >= since` for the row's account), summed per source. `conv:` sources are joined:

```
conversation → attempt → task → mandate (mandateId, mandateSource root)
                              → root's tasks_ext_supervisor (role) / tasks_ext_origin (automation)
```

Classification, first match wins:

| Category | Rule | Drill levels |
|---|---|---|
| Supervisors | root mandate `supervisor-role` (the root is a role session, owned by the role) | role → session (the root's own conversations) vs worker tasks → attempts → conversations |
| Ad hoc | root mandate `supervisor` | root task → worker tasks → attempts → conversations |
| Background | root has `tasks_ext_origin.automationId`; **plus** every `cli:` source (titles, summaries, triage, …) | automation or caller → (automation: tasks → conversations; a caller is a leaf) |
| You | everything else, including conversations without a task | task → conversations |

`unattributed` rows (history before the ledger kept a source) are left out. When a window starts before the first attributed row, the pane says "Counted since <first row>".

**Change signal:** the change feed on `claude_spend_hours`, coalesced. The value recomputes on writes, never by polling. The read is one aggregate over at most a week of hourly rows, which is small.

Names come from the joined rows: task titles (short titles where present), role names, and automation labels. Background source labels come from a `ClaudeCli.SourceLabel` contribution, so a source names itself.

### 4. Web

- **Glance:** a `SpendGlance` at the top of `supervisors-list.tsx`, above the All supervisors entry. It is a card with the total, a thin stacked bar and a 2-column legend.
  - Hovering a segment or legend item highlights it and shows a tooltip.
  - Clicking the card opens the pane at the root; clicking a segment or legend item opens that category.
  - The bar is never muted.
- **Pane:** a new route `spend/*path` in `pane/core/internal/routes.ts`, opened in the list's detail column like a role.
  - The path is the drill path, so Back and links work.
  - Pane component `SpendDetail`:
    - **Title = path.** Breadcrumb segments use the shared breadcrumb separator. Ancestors are faint and clickable. The new segment is wiped in at full colour with a clip-path (never semi-transparent, so exactly one name is bright) and a dropped one is wiped out; the ancestor dims in 160 ms.
    - **Total:** counts to its new value (420 ms, ease-out, progress clamped to [0, 1]); there is only ever one number on screen.
    - **Bar:** the stacked bar zooms into or out of the picked segment with WAAPI (the transform from the prototype's `segOf`). The old bar fades out as a ghost.
    - **Rows:** a `DataView` (`views={["list"]}`) of the children: colour dot, name + sub, a mini bar, %, $, chevron.
      - Clicking a row drills, and only rows with children do. The rest row is inert.
      - A conversation leaf has a hover item action, "Open in a new pane" (`conversationPane`).
      - Rows cross-fade in sequence when the level changes.
    - Esc goes up one level.
- **Colours:** five categorical tokens plus rest, as a token group `spend` in `ui/tokens`. The values are the validated palette from the prototype (`oklch(0.58 0.11 245)`, `(0.665 0.11 80)`, `(0.55 0.10 165)`, `(0.66 0.11 305)`, `(0.56 0.13 30)`; rest a tinted grey). Colours are assigned by order within a level and never cycled. Text uses text tokens.
- **Loading:** until `claudeUsage` and `supervisors.spend` both resolve, the glance shows its skeleton, never $0.
- The `SpendBar` and `CountTo` components stay private to the plugin. Promote them only if a second user appears.

### 5. Files

- `infra/plugins/claude-cli/{core/resources.ts,server/internal/{tables,run-claude-print,record-call}.ts}`: the `claude_spend_hours` table and `spendLedgerUpsert`, the call log's `costUsd` column, the ledger write per call.
- `conversations/plugins/usage/{server/internal/tables.ts,machine/internal/{scan,write}.ts}`: drop the day table, write the ledger by hour with a `conv:` source; the `claudeAccountSpend` serve sums hours per day.
- `tasks/plugins/supervisor-roles/plugins/spend/` (new): core value + schema, server query + serve, web glance + pane.
- `tasks/plugins/supervisor-roles/plugins/pane/{core/internal/routes.ts,web/panes.tsx,web/components/supervisors-list.tsx}`: the route and the glance mount.
  - The glance is a slot the list renders, so `pane` does not import `spend`.
- `ui/tokens`: the `spend` categorical token group.

## Tests

- `scan.test.ts`: spend keyed by hour; costs split across an hour boundary.
- `write.test.ts` (existing, adapted): ledger rows and file rows are written atomically under a `conv:` source; a job pass writes no ledger rows.
- `record-call` test: the call's cost lands in the ledger under `cli:<source>`, and a trim doesn't change the ledger.
- Account spend test: the month read sums hours per day, the migrated `unattributed` rows included.
- Spend query test (worktree-db, rolled back): fixtures for a role session with workers, an ad-hoc root, an automation task, CLI calls and a plain conversation. Check:
  - each lands in the right category and level;
  - top-5 plus rest;
  - each account cut at its own window, API-key accounts at 7 days.
- jsdom: the glance renders a skeleton before data, and clicking a segment routes to `spend/<id>`.

## Verification

1. `./equin build` (generates migrations).
2. Use a conversation in the worktree, then check with `query_db` that its `conv:` rows in `claude_spend_hours` grow with the Cost column, and that Settings → Accounts' spend chart is unchanged.
3. Trigger a title or summary and check its `cli:` row.
4. Drive `/agents/supervisors` with `browser_*`:
   - the glance matches the ledger summed per account window;
   - drill category → role → session → conversation, and back via the path and Esc;
   - "Open in a new pane" works;
   - a role's own page shows no spend.
5. Check the motion against the prototype with `compare-diff.ts --options view=spend` and frames frozen mid-animation.
6. `./equin check`, then `./equin test` on the touched plugins.
