# Claude account spend — which account each dollar was spent on

Task: task-1794530250-mdtx48. Prototype: proto-1793450656-8cpct1 (the foot line only;
the menu card is out of scope).

## Context

An API-key Claude account's sidebar foot says "Billed to API credit" and nothing
else: the user cannot see what it is spending. Anthropic has no balance or live
spend API (Backlog: "Anthropic: no live spend or credit-balance API"), so equin
estimates from what it already counts — the per-conversation cost the usage sync
prices from transcripts (`conversations/usage`).

What is missing is **which account** a cost was spent on: the user switches
accounts during a month, and an agent can move accounts mid-conversation ("Move
them", the switch on hitting a limit). Today the account is chosen at launch
(`runtime-sdk/machine/internal/agent-process.ts` → `--account`) and written into
the agent's pid file (`core/agent-pid-file.ts`, read by `runningAgentAccount`),
but the cost totals carry no account.

Outcome: the foot of a metered account reads `$4.12 today · $86 in Nov`.

## Design

**Attribute at count time.** The usage sync already prices only the tokens newly
counted on each pass (`priceFile` freezes what was priced). A live pass runs right
after the agent appends to its transcript, so the account of the agent running
*now* is the account that spent those tokens. Each pass adds its newly priced
cost, per UTC day, to that account. History is never re-attributed (a chain
re-read prices only the delta, as today).

- Live pass (`requestUsageSync` with written sessions): account = the
  conversation runtime's running account; if the agent already exited, the last
  account this process saw for the conversation (held in `UsageState`).
- Job pass (backfill, reprice) or unknown account: the cost is not attributed
  (spend before this ships is unknown, as agreed).
- Sub-agents and workflow agents run in the parent's process → same account.

**Runtime seam.** `ConversationRuntime` gains `runningAccount(id): Promise<string | null>`
(the Claude account the running agent signs in as; null when none runs or it is
unknown). The sdk runtime answers from `runningAgentAccount`. The usage sync asks
through `conversationRuntime(id)` (conversations server) — it never names
runtime-sdk.

**Storage.** New table `conversation_usage_account_days` in
`conversations/usage/server/internal/tables.ts`:
`(account_id text, date text 'YYYY-MM-DD' UTC, cost_usd double precision)`, PK
`(account_id, date)`. Written in the SAME statement as the file rows (`writeUsage`
gains a third CTE arm, `cost_usd = cost_usd + excluded.cost_usd`), so a failed
write leaves both unmoved and the next pass recomputes the same delta.

**Pricing split.** `priceFile` additionally returns `addedByDate` — the cost it
priced this pass, per bucket date (formerly-unpriced models priced now are dated
by their bucket). Not persisted. Invariant (tested): its sum equals
`costUsd − prev.costUsd`.

**Read.** `liveValue("conversations.usage.account-spend", { params: { accountId, month } })`
in usage core → `{ days: cappedList({ date, costUsd }, max 31) }`, the account's
days of one UTC month. `month` is a clock param (`clockParam.month({ zone: "UTC" })`)
the browser pins with `useClockParam`, so the served read never reads the clock
(`live/no-clock-in-served`). Served `source: "db"` reading the new table. The
browser picks today from `useNow` (UTC days, like Stats → Cost).

**Foot.** `runtime-sdk/web/components/claude-account-foot.tsx`: a metered
account's `WeekGlance` shows `$X today · $Y in <Mon>` on one truncating line
(`$0` for nothing, cents below $10; loading while unknown, the error inline). The menu card is unchanged.

## Files

- `plugins/conversations/server/internal/runtime.ts` — contract method.
- `plugins/conversations/plugins/runtime-sdk/machine/internal/sdk-runtime.ts` — implement it.
- `plugins/conversations/plugins/usage/machine/internal/{scan,sync,write}.ts` — split, attribute, write.
- `plugins/conversations/plugins/usage/server/internal/{tables,served}.ts`, `server/index.ts` — table + served value.
- `plugins/conversations/plugins/usage/core/shape.ts` — the live value.
- `plugins/conversations/plugins/runtime-sdk/web/components/claude-account-foot.tsx` — the line.
- Tests: `scan.test.ts` (`addedByDate`), `write.test.ts` (spend arm accumulates).

## Verification

- `./equin test plugins/conversations/plugins/usage`
- `./equin build`, then run an agent on an API-key account in this worktree and
  read `conversation_usage_account_days` with `query_db`; screenshot the foot.

## Known limits

- Spend before the deploy, and spend outside equin, are not counted.
- Days are UTC: the user's "today" (UTC+1) rolls over an hour late.
- Tokens appended after the agent exited are attributed to the last account this
  process saw; after a server restart in that window, they go unattributed.
