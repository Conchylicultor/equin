# Claude usage limits on demand (account switch / add / refresh)

## Context

The health report's Claude Code row shows the active account's session / week
meters from `runtime-sdk.claude-usage`. Today the only writer is an agent
turn: `bin/agent.ts` parses each `rate_limit_event` (`claudeUsageOf`) and
overwrites `state/claude-usage/<accountId>.json`. So after switching to (or
adding) an account, the meters show nothing or a stale reading until an agent
launches on that account and finishes a turn. Auto-switch also ranks a
never-reported account below every known one (`roomiestAccount`), so a fresh
account is invisible to it. "Check again" only re-probes the `claude` binary
(`recheckClaudeCode`), which made this look like a refresh bug.

Goal: read an account's limits **without an agent turn**, on add, on switch
and on an explicit refresh, written to the same per-account file so meters,
`weekRoom`, `limitReached` and auto-switch work immediately, with no
downstream change.

## Source of truth: the SDK's `get_usage` control request

The pinned Agent SDK (0.3.303, `sdk.d.ts:3102`) exposes the data behind
Claude Code's `/usage`:
`query.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true })`
→ `SDKControlGetUsageResponse { rate_limits_available, rate_limits: { five_hour, seven_day, … } }`,
each window `{ utilization: 0–100 | null, resets_at: ISO | null }`.

We use it instead of a raw `GET /api/oauth/usage`. Claude Code owns the
endpoint, its headers and its auth, including the **system** account's
keychain login, which we can't read ourselves. The method is typed, so a
rename on an SDK bump fails `tsc` (the deps updater's type-check catches it)
rather than going silent. `skipBehaviors` avoids the 7-day transcript scan.

**Risk, gated in step 0:** `rate_limits_available` is false for "missing
profile scope". Tokens from `claude setup-token` may be inference-only. If
they are, token accounts can't be read this way. The probe then answers
`unavailable`, honestly, and we revisit (see Open question).

## Design

All of this lives in `conversations/runtime-sdk`, which already owns the usage
dir, the parser and the account picker. That avoids the accounts →
runtime-sdk cycle.

1. **Core** (`core/claude-usage.ts`)
   - `claudeUsageOfReply(reply, observedAt): ClaudeUsage | null` maps the SDK
     reply onto the existing `ClaudeUsage`: utilization / 100, `Date.parse`
     of the reset time, a window with a null field becomes `null`. It returns
     `null` when `!rate_limits_available`.
   - A new endpoint
     `refreshClaudeUsage = defineEndpoint({ route: "POST /api/claude-usage/refresh", body: { accountId }, response: RefreshOutcome, needsMachine })`.
     - `RefreshOutcome` is a discriminated result:
       `{ kind: "read", usage } | { kind: "unavailable", reason }`. It is not
       `null`.

2. **Shared write.** Extract agent.ts's inline tmp + rename (`recordUsage`)
   into `writeClaudeUsageFile(path, usage)`. This is runtime-agnostic node
   code, in `shared/` or `core/` (whichever the boundary table allows for
   `bin` + `machine`). The agent and the probe then write identically.

3. **Machine probe** (`machine/internal/usage-probe.ts`)
   - `probeClaudeUsage(accountId)`:
     1. Get the token with `claudeAccountToken(id)` (null means the system
        account, which uses Claude Code's own login).
     2. Start `query()` in streaming-input mode with a prompt iterable that
        never yields. Use the same `pathToClaudeCodeExecutable` as launches
        and `env` carrying `CLAUDE_CODE_OAUTH_TOKEN` only for token accounts,
        mirroring agent.ts.
     3. Call the usage method, then `close()`. No turn is sent, so no quota
        is spent.
     4. On `read`, write `claudeUsagePath(accountId)`. The existing dir watch
        notifies `runtime-sdk.claude-usage`, so no extra wiring is needed.
   - It is single-flighted per account with `packages/inflight`, so concurrent
     clicks share one CLI spawn.
   - Errors (CLI spawn, timeout, an unparseable reply) throw. They are not
     absorbed.
   - The handler `implementMachine(refreshClaudeUsage, …)` is registered under
     `httpRoutes` in `machine/index.ts`.

4. **Triggers** (web, `components/claude-accounts.tsx` and
   `claude-usage-glance.tsx`)
   - After a successful **add** or **select** mutation, the picker fires
     `refreshClaudeUsage({ accountId })` for that account. The meter shows its
     pending state while it runs.
   - A **refresh icon on the usage meters**, separate from "Check again",
     refreshes the active account. It uses the `IconButton` + endpoint-
     mutation pattern of `ClaudeCodeActions`, and auto-pends.
   - An `unavailable` outcome is shown inline under the meter ("This account's
     limits can't be read without a turn"). It is never a blank meter.
   - Auto-switch at launch needs nothing new: the switch launches an agent,
     whose turn reports.

5. **Docs.** Update runtime-sdk `CLAUDE.md`'s "Usage limits" bullet. The usage
   file now has two writers (agent turns and the probe), and "current only
   while agents run" becomes "or when refreshed".

Out of scope: periodic background refresh. Use a `defineJob` schedule later
if wanted; never a timer.

## Critical files

- `plugins/conversations/plugins/runtime-sdk/core/claude-usage.ts`: reply
  mapper, endpoint, outcome schema.
- `plugins/conversations/plugins/runtime-sdk/bin/agent.ts:43-59`: switch to
  the shared writer.
- `plugins/conversations/plugins/runtime-sdk/machine/internal/usage-probe.ts`
  (new), `machine/index.ts`, `machine/internal/paths.ts`
  (`claudeUsagePath`, reused).
- `plugins/conversations/plugins/runtime-sdk/web/components/claude-accounts.tsx`
  and `claude-usage-glance.tsx`.
- Reuse: `claudeAccountToken` (`infra/claude-cli/accounts/server`),
  `implementMachine` / `defineEndpoint` (`infra/endpoints`), `createInflight`
  (`packages/inflight`), the existing `claudeUsageServed` watch.

## Steps

0. **Spike (gate).** Run a script calling the usage method for the system
   account and for one token account, and print `rate_limits_available` and
   `rate_limits`. If it is false for token accounts, stop and decide the Open
   question before building.
1. Core mapper and endpoint, with a unit test of `claudeUsageOfReply`
   (percent → fraction, ISO → ms, null windows, unavailable).
2. Shared writer, and switch agent.ts to it.
3. Machine probe and route.
4. Web triggers and the refresh button.
5. Update `CLAUDE.md`, then `./singularity build`.

## Verification

- `./singularity test plugins/conversations/plugins/runtime-sdk`.
- On the worktree build (`http://<worktree>.localhost:9000`):
  1. Add or switch to an account that has no `state/claude-usage/<id>.json`.
     The week meter fills within a few seconds, with no conversation launched.
  2. Click refresh: `observedAt` in the file advances.
  3. Compare the values with `claude /usage` run under the same account.
- Auto-switch: with the active account marked full (a hand-edited file in a
  test DB/state), a freshly added account ranks by its real weekly room, not
  as "unknown".

## Open question (decided after step 0)

If `setup-token` tokens lack the profile scope, the fallback is a **probe
turn**: a one-message `maxTurns: 1` Haiku query on the account, whose
`rate_limit_event` the existing `claudeUsageOf` already parses. It costs a
sliver of quota per refresh. Use it only for token accounts, and only on an
explicit add/switch/refresh.

## Outcome (implemented 2026-10-22)

- Spike: the system account (Claude Code's own sign-in) answers in ~1 s,
  `rate_limits_available: true`, values matching the last agent report (7 % /
  81 %). No token account existed on this machine, so the setup-token scope
  question is untested; that path answers `unavailable` honestly if it hits it.
- Added beyond the plan: every fresh Claude Code probe (Check again included)
  re-reads the **active** account's limits, server-side (`onClaudeCodeProbed`).
  The motivating case was a `claude auth login` as another user — the system
  account's file then held the previous login's numbers, and Check again
  refreshed nothing. No separate refresh button: Check again now covers it.
- The shared writer (step 2) was dropped: `server/` may not import `node:fs`
  (`boundaries/no-platform-api`) and `bin/` cannot import `machine/`, so the
  agent keeps its inline tmp + rename and the machine side has
  `writeClaudeUsageFile` beside the reader (`machine/internal/claude-usage.ts`).
