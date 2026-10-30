# Pushing from a session equin did not launch

## Context

An agent session started outside equin (a plain `claude` in a terminal — the
usual case while recovering a broken main) has no `EQUIN_CONVERSATION_ID`. The
`conversation-trailer` check refused every push *and every build* from such a
session ("STOP"), so the recovery session could not land its fix. The env var is
required only because the conversation trailer was the one way a push was
credited to its task.

Goal: credit the push from what the checkout itself says, and give a
deliberate, recorded escape for a checkout that names no attempt.

## Design

### 1. The attempt trailer — derived, not delivered

An attempt's checkout is on branch `claude-web/<attemptId>` (the one definition:
`infra/worktree/core` `attemptBranchName` / `stripAttemptBranchPrefix`). Push
stamps `Equin-Attempt: <attemptId>` on every commit it lands from such a branch,
in the same `git commit --amend --trailer` that already stamps the push trailer
(the rebase `--exec` and arm 1's tip amend). The branch cannot misname itself, so
this cannot reintroduce the Sep 9 misattribution (an inherited env).

Readers accept either trailer:

- `tasks-core/core/internal/trailers.ts` — the grammar gains
  `ATTEMPT_TRAILER_KEY` / `UNATTRIBUTED_TRAILER_KEY`; `TRAILER_LOG_FORMAT` emits
  the attempt trailer; `TrailerCommit` carries `conversationId: string | null`
  and `attemptId: string | null` (a commit is kept when it has the push trailer
  and at least one of them).
- `push-ledger/plan.ts` — the attempt is the conversation's (authority) or else
  the trailer's. `pushes.conversationId` is already nullable; no migration.
- `attempt-work` `readLanded` — a commit is the attempt's when it names one of
  its conversations OR the attempt itself.
- `pushes.landed` payload: `conversationId: string | null`;
  `conversation-progress` marks the attempt's conversations from `attemptId`.

### 2. `./equin push --unattributed "<reason>"`

For a checkout that is no attempt's (hand-made branch) and a session with no
conversation: stamps `Equin-Unattributed: <reason>` instead of failing. Refused
when the push IS attributable (env set, or an attempt branch) — so it can never
discard a real attribution. Its description says agents pass it only with the
user's approval in the current conversation (like `--from-main`). The ledger
writes no row (no attempt to hang the FK on); git history records why.

### 3. The check

`conversation-trailer` (runs after push's stamping, and in build):

- env set → unchanged (every own commit carries this conversation's trailer).
- env unset, attempt branch → ok (push credits the attempt).
- env unset, no attempt → every own commit must carry a conversation, attempt
  or unattributed trailer; the failure names `--unattributed` and the approval
  rule instead of a bare STOP.

## Files

- `plugins/tasks/plugins/tasks-core/core/internal/trailers.ts` (+ test, barrel)
- `plugins/tasks/plugins/tasks-core/server/internal/push-ledger/plan.ts` (+ test),
  `machine/internal/push-ledger/reconcile.ts`, `server/internal/mutations/pushes.ts`,
  `server/internal/tables-events.ts`
- `plugins/tasks/plugins/attempt-work/server/internal/{measure,work}.ts` (+ test)
- `plugins/conversations/plugins/conversation-progress/server/internal/push-job.ts`
- `plugins/framework/plugins/cli/plugins/push/cli/{index,run}.ts`
- `plugins/framework/plugins/tooling/plugins/checks/plugins/conversation-trailer/{check/index.ts,CLAUDE.md}`

## Verification

- `./equin test` on tasks-core, attempt-work (trailer parse, ledger plan,
  readLanded by attempt).
- `env -u EQUIN_CONVERSATION_ID ./equin check conversation-trailer` passes on an
  attempt branch.
- `./equin check`, `./equin build`.
