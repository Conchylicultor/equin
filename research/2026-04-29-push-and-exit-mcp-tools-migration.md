# Push-and-exit: text tokens → MCP tools

## Context

Today push-and-exit asks the model to type `EXIT_CLEAN` or `FLAG_RAISE` on the last line of its final message, then a server-side durable job watches the JSONL transcript and parses those strings. The detection code is fragile (last-line equality, whitespace handling, race guards against pre-push end_turns) and effectively re-implements a typed protocol in plain text.

`Mcp.registerTool` is already the unified "model → app" channel — `add_task`, `submit_conversation_summary`, and the `yak_*` family use it. The right move is to replace the two tokens with two real MCP tools (`exit_clean` and `flag_raise`), kept inside the push-and-exit plugin. The model gets typed args and a tool description; the server keeps the existing job + status table so the toolbar UX doesn't change.

A small new helper, `afterTurn(ctx, conversationId)`, captures the "wait for the next end_turn for this conversation" primitive — needed because `exit_clean` deletes the conversation and we don't want to yank the runtime out from under a still-streaming response. The push-and-exit job and the `exit_clean` finalize job will both consume it.

The active-data `tokens` sub-plugin (visual chips for the literal strings) loses its purpose and is deleted in the cleanup phase. Tool calls already render via the JSONL `assistant-tool-use` slot, which is a better surface anyway.

## Design

### New MCP tools

Registered from `push-and-exit/server/index.ts` at plugin load:

- **`exit_clean`** — `inputSchema: {}`. Handler: `setStatus(conversationId, "clean", null)` synchronously, then enqueue `exitCleanFinalizeJob` keyed by conversationId. Returns `{"ok":true,"deferred":"close on end_turn"}`.
- **`flag_raise`** — `inputSchema: { reason: z.string().min(1) }`. Handler: `setStatus(conversationId, "flag", reason)` synchronously. Returns `{"ok":true}`.

Naming: `mcp__singularity__exit_clean` / `mcp__singularity__flag_raise` (the `mcp__singularity__` prefix is automatic from the `McpServer({ name: "singularity" })` declaration in `plugins/infra/plugins/mcp/server/internal/handle-mcp.ts:14`).

Errors: throw `new Error(...)` (matches `add_task`/`submit_conversation_summary` convention).

### `afterTurn` primitive

Single thin wrapper around the existing `ctx.waitFor(conversationTurnCompleted, …)` pattern. Lives in **`plugins/conversations/server/internal/after-turn.ts`**, re-exported from `plugins/conversations/server/index.ts`.

```ts
import type { JobCtx } from "@plugins/infra/plugins/jobs/server";
import {
  conversationTurnCompleted,
  type ConversationTurnCompletedPayload,
} from "./tables-turn-completed-event";

export async function afterTurn(
  ctx: JobCtx,
  conversationId: string,
  opts?: { timeoutMs?: number },
): Promise<ConversationTurnCompletedPayload | null> {
  return ctx.waitFor(conversationTurnCompleted, {
    where: { conversationId },
    timeoutMs: opts?.timeoutMs ?? 60_000,
  });
}
```

Why a JobCtx-bound helper rather than a top-level Promise: durability. End-turns can lag behind the tool call; we need the wait to survive a server restart. `ctx.waitFor` already provides that via the events/jobs DB tables.

### `exitCleanFinalizeJob`

New durable job in `push-and-exit/server/internal/exit-clean-finalize-job.ts`:

```ts
export const exitCleanFinalizeJob = defineJob({
  name: "push_and_exit.exit_clean_finalize",
  maxAttempts: 3,
  run: async (ctx, { conversationId }: { conversationId: string }) => {
    await afterTurn(ctx, conversationId, { timeoutMs: 60_000 });
    await deleteConversation(conversationId);
    recentConversationsResource.notify();
  },
});
```

Idempotency: `deleteConversation` is already a no-op if the tmux session is gone (verified — see `plugins/conversations/server/internal/lifecycle.ts:171` → `tmux-runtime.ts:184`, swallows non-zero exit). DB row deletion via `deleteConversationRow` is also idempotent (`tasks-core/server/internal/mutations/conversations.ts:109`, `db.delete` + 0-row update pattern). Re-runs are safe.

Job dedup: `enqueue({ conversationId }, { jobKey: conversationId })` so a model that calls `exit_clean` twice in a row enqueues only one finalize.

### Reworked `pushAndExitJob`

Same shell, three changes:

1. **Race-guard needle.** `endTurnIsAfterPushPrompt` (currently `push-and-exit-job.ts:73-95`) looks for a user message containing both `EXIT_CLEAN` and `FLAG_RAISE`. Switch to matching the push prompt's distinctive opening line — `"Please wrap up this conversation:"` — which the new prompt still carries (see prompt update below). Same algorithm, different needle.
2. **Verdict logic.** Replace the `interpret(text)` + `setStatus(...)` block at `push-and-exit-job.ts:154-167` with: re-read current status; if still `"running"`, set `"flag"` with `"Claude ended the turn without calling exit_clean or flag_raise."`; otherwise (a tool already set `clean` or `flag`) do nothing.
3. **Delete `interpret`.** Lines 20-30 + the `CLEAN_TOKEN`/`FLAG_TOKEN` constants are unused after this.

Status-write coordination: tool handlers write synchronously during the turn; the watchdog only writes when `status === "running"`. No locking needed — the worst case is two writes from the same conversation, and the tool-handler write always lands first because the watchdog only fires post-`end_turn`.

Existing `setStatus` (push-and-exit-job.ts:54-64) is unconditional; that's fine. The conditional logic lives in the watchdog read+check, not in `setStatus`.

### Prompt rewrite

Update `push-and-exit/server/internal/prompt.ts`:

- Drop `CLEAN_TOKEN` / `FLAG_TOKEN` exports.
- Rewrite `PUSH_AND_EXIT_PROMPT` to instruct the model to call the MCP tools instead of typing tokens. Keep the opening line `"Please wrap up this conversation:"` so the race-guard needle stays stable. Approximate shape:

  > Please wrap up this conversation:
  >
  > 1. Push this branch to main using the CLI.
  > 2. Then call exactly one tool:
  >    - `exit_clean` — everything went smoothly, nothing I need to know.
  >    - `flag_raise({ reason })` — something needs my attention. Use `reason` for the short bullets.

Exact wording can be tuned during implementation; the contract is "first line stays distinctive" + "names the two tools".

## Files

### Modified

- `plugins/conversations/server/index.ts` — re-export `afterTurn`.
- `plugins/conversations/plugins/conversation-view/plugins/push-and-exit/server/index.ts` — register the two MCP tools at plugin init; import the new finalize job so it's registered.
- `plugins/conversations/plugins/conversation-view/plugins/push-and-exit/server/internal/prompt.ts` — drop token constants, rewrite prompt body.
- `plugins/conversations/plugins/conversation-view/plugins/push-and-exit/server/internal/push-and-exit-job.ts` — delete `interpret`; switch needle in `endTurnIsAfterPushPrompt`; replace verdict block with status read + conditional flag.

### New

- `plugins/conversations/server/internal/after-turn.ts` — the helper.
- `plugins/conversations/plugins/conversation-view/plugins/push-and-exit/server/internal/exit-clean-finalize-job.ts` — the finalize job.

### Deleted (cleanup phase)

- `plugins/active-data/plugins/tokens/` — all 5 files.
- `web/src/plugins.ts:61` (import) and `web/src/plugins.ts:106` (registry entry) — confirmed only references in the codebase.

## Migration order

Do not split across deploys. One worktree, one `./equin build`, one push:

1. Add `afterTurn` to `plugins/conversations/server`.
2. Add `exitCleanFinalizeJob`.
3. Register `exit_clean` + `flag_raise` MCP tools in `push-and-exit/server/index.ts`.
4. Rewrite `PUSH_AND_EXIT_PROMPT` and update the race-guard needle in the same commit (the prompt-and-needle pair must move together).
5. Replace `interpret`-based verdict with the status-read watchdog; delete `interpret` + token constants.
6. Cleanup: delete `plugins/active-data/plugins/tokens/` and its two registration lines in `web/src/plugins.ts`.
7. `./equin build`.

Step 6 can be its own commit if we want a clean revert window for the chips, but it's safe to bundle — nothing depends on the regexes or the chip component (verified: zero non-self consumers of `EXIT_CLEAN_RE` / `FLAG_RAISE_RE`).

## Verification

End-to-end happy paths to exercise manually after `./equin build`:

1. **Clean exit.** From any conversation, click the push-and-exit toolbar button. Expect: model pushes, calls `exit_clean`, status flips to `clean`, then the conversation closes after the model's end_turn. The toolbar button's existing toast surfaces the clean state.
2. **Flag raise.** Trigger push-and-exit on a conversation with intentional uncommitted changes (or otherwise blocked). Expect: model calls `flag_raise({ reason })`, status flips to `flag` with the reason as detail, conversation stays open.
3. **No tool called.** Send the prompt manually via DB (or have the model not call a tool — hard to force, can lower the watchdog timeout for one test run). Expect: status flips to `flag` with `"Claude ended the turn without calling exit_clean or flag_raise."`.
4. **Watchdog timeout.** Same as above but no end_turn within the deadline. Expect: `"Claude didn't end its turn within 10 minutes."` (existing behavior, unchanged).

UI sanity check (no `e2e/screenshot.mjs` script needed — pure backend change with no new UI):

- Confirm tool calls render as expected via the existing `assistant-tool-use` JSONL renderer (this is the replacement for the deleted chips).
- Confirm `EXIT_CLEAN` / `FLAG_RAISE` strings no longer appear anywhere in assistant text in fresh conversations.

Sanity check the deletion didn't break anything: `./equin check --plugin-boundaries` should pass; `web/src/plugins.ts` should still typecheck after the two-line removal.

## Out of scope

- Generic `defineSignal(name, schema, handler)` wrapper — `Mcp.registerTool` already is the API.
- `drop-and-exit` / `hold-and-exit` reworks — they don't parse tokens today; nothing to migrate.
- Per-tool permission gating — both new tools are universally callable; revisit if a future signal needs scoping.
- Visual replacement for the deleted chips — the JSONL `assistant-tool-use` renderer covers it.
