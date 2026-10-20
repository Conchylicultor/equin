# SDK Claude: rollout on main, parity gaps, and the Phase 2 decision

Track: wiki *Mental model → Agent Manager → SDK Claude* (`block-3005117a-178e-45d1-a3b7-6587b8944191`). Previous step: `research/2026-10-20-conversations-sdk-default-and-tmux-removal.md`.

## Context

sdk became the only conversation runtime on main at `30c7830fd9` (10:10 UTC, 2026-10-20). Five exit-criteria items are still open:

- the rollout itself;
- model switch, effort and compaction context on sdk;
- the transition-only code;
- one unexplained 32 s stall;
- two items deferred last session: the leftover hook-era naming, and the usage limit.

After those comes the Phase 2 decision.

### What main shows today (read-only checks, this session)

- **The move ran.** No `runtime='tmux'` row is left on main: 5,323 done, 29 waiting (28 hibernated), 1 working, 2 gone. `tmux ls` shows 5 sessions, all marked `@singularity-host=sdk`. No live tmux-runtime agent is left on the machine.
- **Resume works, but no Send has gone through yet.** Two moved conversations have been resumed on sdk, both by opening their page (`hibernation/server/internal/handle-viewed.ts` → `ensureResumed`), not by a Send.
  - `conv-1792445817-k9w68e`: the agent is `ready`, keeps the same Claude session id, and is `waiting`.
  - `conv-1792445997-89ecr1`: the previous session. It was resumed, then closed.
  - Main has 3 turns on sdk agents since the move, all `accepted`. **None of them was sent to a moved conversation.** So "the next Send works" still needs one live turn.
- **171 `att-*` databases exist.** A database forked before the move still holds tmux rows until its backend next boots on new code.

### Findings from the research

1. **Model switch: not implemented.** The pieces exist but nothing connects them:
   - the agent handles a `setModel` command (`runtime-sdk/core/protocol.ts:52`, `bin/agent.ts:347`), and `Query.setModel` exists in the SDK;
   - nothing sends it: the `ConversationRuntime` contract (`conversations/server/internal/runtime.ts`) has no method for it, there is no endpoint, and there is no picker on the conversation;
   - on tmux, a user typed `/model …` into the prompt. Whether `/model` typed as a turn works in the SDK's streaming-input mode has not been checked.
2. **Effort: applied only at launch and resume.**
   - The task's effort is read again on resume (`lifecycle.ts` `resolveTaskEffort`), so a change reaches a live agent only after it hibernates.
   - The SDK has `Query.applyFlagSettings({ effortLevel, ultracode })` (`sdk.d.ts:~2997`), which changes it live.
3. **Compaction context: wired, never seen firing.**
   - The `SessionStart(compact)` hook reaches the CLI through inline `settings.hooks` (`agent-launch/server/internal/launch-settings.ts:41`, `runtime-sdk/server/internal/launch-options.ts:49`).
   - No test or live run shows it firing.
   - Its script needs `SINGULARITY_CONVERSATION_ID` and `SINGULARITY_PARENT_HOST` in the agent's environment.
4. **Usage limit.** The CLI writes a synthetic `assistant` entry with `isApiErrorMessage: true` and model `<synthetic>` to the transcript. It is the same entry tmux produced; real ones exist in old transcripts.
   - The viewer draws it as an ordinary assistant line.
   - The reducer sets idle on any `result`, error or not (`runtime-sdk/server/internal/reducer.ts:200`).
   - The `rate_limit_event` messages, which carry the reset time, are recorded in `events.jsonl` but never read.
   - Status is correct (idle). What is missing is a visible "limit hit, resets at …" in the conversation.
5. **Hook-era naming, and a probable bug.**
   - `turn-ledger/server/internal/store.ts:39` `isHooklessText` marks every `/…` or `!…` turn `hookless`.
   - Hookless rows are excluded from confirmation candidates (`transition.ts:121`). So a `/compact` turn on sdk is likely never confirmed, even though sdk reports it with `turn_started`.
   - `recordPromptHookLaunch` and the `conversation_prompt_hooks` table only record "launched", which on sdk is always true.
6. **32 s stall.** The CLI held a queued turn until its MCP servers were connected (`deferred_tools_delta` / `mcp_instructions_delta`), right after a backend restart. The Singularity MCP server is that backend. It was seen once.
7. **Phase 2.**
   - **Not needed for AskUserQuestion.** The card comes from the question-relay hold, fed by `events.jsonl`. In 4 real cases, the transcript's `tool_use` was written 5–11 ms *before* the `permission_request`.
   - **Content latency is not the transcript-vs-SDK timing.** Transcript entries are timestamped within 0–15 ms of the SDK message (median about 2 ms). The cost is in the pipeline after that:
     - `transcript-watcher` re-reads and re-parses the whole chain on every write;
     - `jsonl-events` ships the whole event array on every change;
     - so each update costs O(transcript), and transcripts reach 50 MB.
   - **A full switch** costs several thousand lines and loses the exact-mirror property, plus everything that comes only from the transcript: attachments, `api-request*`, `ai-title`, `cost-state`, `file-history-snapshot`, and the rewind, usage and backup readers.
   - **Token streaming** needs only `includePartialMessages`, shown as an overlay.

## Plan

### A. Close the rollout (this session)

1. **Confirm the Send: done.** The user has interacted with old, moved conversations on main, and they resumed on sdk.
2. **Retire the transition code.** Replace the boot step with a SQL migration, and delete the mark.
   - **The migration.** Every `runtime='tmux'` row becomes `sdk`. A non-done row also gets `hibernated_at = coalesce(hibernated_at, now())`, and a `working` row becomes `waiting`. This is the boot step's DB half, as data (`runtime-sdk/server/internal/tmux-adoption.ts` has the rules).
     - A forked database picks it up on its next build.
     - Its session-killing half is no longer needed: no tmux-runtime agent is alive on the machine.
     - If a stale worktree still had one, the sdk resume would fail loudly with tmux's duplicate-session error, not run two agents on one session.
   - **Delete** `machine/internal/adopt-tmux-rows.ts`, `tmux-adoption.ts` and its test, and `listTmuxConversations` / `moveToSdkRuntime` from `rows.ts`.
   - **Delete the `@singularity-host` mark** (`agent-launch/core/host-option.ts` and its use in `sdk-runtime.ts:147`). Only a backend still running Phase-1 code reads it: a worktree based between `89cd4f125b` and `30c7830fd9` and never rebased. Before deleting, list the running worktree backends (`~/.singularity/sockets/*.sock`) and check each checkout's HEAD for `30c7830fd9`. If any predates it, keep the mark for now.
   - **Migration mechanics.** The `retire_tmux_runtime` migration shows how the previous session wrote a data migration, and `./singularity build` generates the migration. Find out whether a hand-written data migration has a sanctioned spelling before writing one.

### B. Parity (this session)

1. **Model switch and effort: no change (user decision).** They apply at launch and resume. Not being able to change them mid-turn is acceptable.
2. **Compaction context.**
   - Check that `bin/agent.ts`'s environment carries the two variables the hook script needs.
   - Live check: a test `CompactionContext` (or a page with instructions) plus a `/compact` turn. The transcript should show `compact_boundary`, then the hook's `additionalContext` attachment.
   - Fix whatever does not fire, and fix the stale comments (`compaction-context/core/hook.ts`, `agent-launch` docs that describe a typed tmux pane).
3. **Usage limit.**
   - In jsonl-viewer, a renderer for `assistant` entries with `isApiErrorMessage`: an error-tinted row holding the CLI's message.
   - In the runtime-sdk reducer, keep the last `rate_limit_event` reset time in `conversations_ext_sdk_agent`. The row shows "resets at …" from it.
   - Status stays idle. An auto-resume at the reset time is a separate, later decision.
4. **Turn-ledger cleanup.** Delete `hookless` (column, `isHooklessText`, the transition filters), `recordPromptHookLaunch`, `hasPromptHook` and `conversation_prompt_hooks`. A `/` or `!` turn then confirms through `turn_started` like any other.
   - Add a test: a `/compact` turn reaches `accepted`.
   - First check that `resolvePromptSubmit` matches a slash turn's text, and whether the `typed` / `unverified` states still have a producer. Delete them if not.

### C. The 32 s stall (bounded, this session)

- Try to reproduce it twice: launch a conversation right after `./singularity build` restarts the worktree backend, then queue a second turn.
- Record when the `init` message arrives and each MCP server's status in it (the agent already logs every SDK message).
- If it reproduces, the cause is the CLI waiting on an MCP server that is not up yet. Look for a fix we own, such as starting the agent's launch only once the backend serves `/mcp`, or the CLI's MCP connect timeout.
- If it does not reproduce, record that and close the item.

### D. Phase 2: discussed next session

The user wants to work out what Phase 2 should look like in the next session, not build it now. Input for that discussion: the findings in point 7, and the candidate design below.

- The candidate is a streaming overlay over the transcript. `includePartialMessages` is turned on, and the in-flight message is kept as a transient live value that the viewer drops when the final `assistant` lands.
- Before that, the transcript should reach the page as appended deltas, not the whole array.
- There is no full switch to SDK messages.

## Critical files

- `plugins/conversations/plugins/runtime-sdk/`: `bin/agent.ts`, `core/protocol.ts`, `machine/internal/sdk-runtime.ts`, `server/internal/reducer.ts`, `server/internal/rows.ts`, `server/internal/tables.ts`. Deleted: `adopt-tmux-rows.ts`, `tmux-adoption.ts`.
- `plugins/conversations/server/internal/`: `turns.ts`.
- `plugins/conversations/plugins/turn-ledger/server/internal/`: `store.ts`, `transition.ts`, `tables.ts`.
- `plugins/conversations/plugins/agent-launch/`: `core/host-option.ts`, `server/internal/launch-settings.ts`.
- `plugins/conversations/plugins/compaction-context/`, `jsonl-viewer` (api-error renderer).

## Verification

1. `./singularity test` on runtime-sdk, turn-ledger, conversations and compaction-context. New tests:
   - the reducer keeps the reset time;
   - the ledger confirms a `/compact` turn.
2. `./singularity check`, then `./singularity build` in the background.
3. On the worktree, with Haiku conversations:
   - run `/compact`; the context attachment appears and the turn is `accepted`;
   - check the usage-limit renderer against a recorded `isApiErrorMessage` line (an exhibit, or a fixture in a jsonl-viewer test).
4. Update the track page: tick Rollout, set the next step to the Phase 2 design discussion, and file that one task.

---

## Results (2026-10-20)

**A. Rollout.**
- The user confirmed that moved conversations resume on sdk on main.
- The boot step is now the data migration `retire_tmux_rows`. It hibernates every open tmux row (a `working` / `starting` one settles to `waiting`), then sets `runtime='sdk'` on every tmux row.
- Deleted: `adopt-tmux-rows.ts`, `tmux-adoption.ts` and its test, and `listTmuxConversations` / `moveToSdkRuntime`.
- A Phase-1-era worktree DB (`att-1792448915-204h89`) still holds 5,351 tmux rows, 31 of them open. It is moved on its next build.
- **The `@singularity-host` mark stays.** Four checkouts are still on Phase-1 code (`att-1792434366-868hai`, `att-1792448915-204h89`, `att-1792449291-1y0q6d`, `att-1792449581-w05d6i`), and their backends can start on demand. Drop the mark once they are rebased or gone.
- **Correction to the plan.** A leftover live tmux-runtime session would not fail with a duplicate-session error. sdk `create` kills any tmux session with the conversation's name first (`sdk-runtime.ts`), whoever launched it. See the hazard below.

**B. Parity.**
- **Compaction context works on sdk.** Two `/compact` turns ran through the API on a Haiku conversation in this worktree.
  - With nothing to restore: `SessionStart:compact` started and returned with exit 0 and no output, then `compact_boundary`.
  - After the agent called `read_page` (page instructions received): the hook returned the instructions as `additionalContext`, and the transcript holds the `hook_additional_context` attachment.
- **`/compact` turns now confirm.** Both reached `accepted` through `turn_started`, which a hookless row never did.
- **Turn ledger.**
  - Deleted: `hookless` (column, `isHooklessText`, the candidate filters, the `typed` / `unverified` argument), `recordPromptHookLaunch`, `hasPromptHook` and `conversation_prompt_hooks` (schema migration `drop_turn_hookless`).
  - Renamed: the `hook` event to `confirmed`, `HOOK_ROLE` to `CONFIRM_ROLE`, `HOOK_RESOLVABLE_STATES` to `CONFIRMABLE_STATES`. The docs now describe the sdk confirmation.
  - On the web, the hookless rule became `isSlashCommand(text)`. A slash command lands as no prompt row in the transcript, so its echo retires once the agent has `accepted` it, and it is not counted in the ordinal landing match. A `!` line is an ordinary prompt on sdk (print mode has no bash mode).
- **Usage limit.** The CLI's synthetic `isApiErrorMessage` line already carries the reset time ("You've hit your session limit · resets 6:20pm (Europe/Paris)") and an `error` kind (`rate_limit`, `server_error`, `authentication_failed`, …; 146 such lines exist in old transcripts). So the reducer keeps no `rate_limit_event` state. Instead:
  - the parser emits a new `api-error` event;
  - a new `jsonl-viewer/api-error` row draws it as a warning ("Usage limit", "API error · server error") rather than as the agent's words;
  - exhibit: `jsonl-viewer/api-error`.

**C. The 32 s stall: CLI cold start under host load, not our path.**
- Launch right after the build restarted the backend (the backend had been ready 16 s before), with a second turn queued 1 s later:
  - started → `ready` took **16.8 s**;
  - both turns went in the moment the CLI was ready;
  - the second turn's model call then took 14.7 s (9.8k cache written), against 1.1 s for the first (44k written). That is server-side.
- A second cold launch a minute later: 11.5 s to `ready`.
- Across today's sdk launches, started → `ready` runs from **1.5 s to 17 s** and tracks host load: 1.5–3.8 s in the morning, 5–17 s in the afternoon, with load averages of 22 and 28 over 5 and 15 minutes at the 16.8 s launch.
- A turn queued while the CLI starts waits for `ready`. That was the 32 s case's shape: the CLI's own startup, not a stall in the runtime. Nothing to fix on our side; the item is closed.

**Hazard found (Phase 1, not fixed here).** The agent's socket (`sockets/agents/<id>.sock`) and state dir (`state/sdk-agents/<id>/`) are host-wide and keyed by conversation id only, but a worktree DB is a fork of main's that holds the same ids. From a worktree backend:
- `isRunning` answers through main's live agent, and sends would reach it;
- the consumer tails main agents' `events.jsonl` into the worktree DB;
- opening a hibernated forked conversation resumes main's Claude session under main's id;
- `create` kills a same-named tmux session.

The tmux runtime guarded against this with `SINGULARITY_PARENT_HOST`; the sdk runtime needs an owner check, or namespaced agent paths.
