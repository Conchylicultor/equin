# SDK Claude — Phase 1 finish: explain the latency gap, make sdk the only runtime, delete tmux UI-driving

Track: wiki *Mental model → Agent Manager → SDK Claude* (`block-3005117a-178e-45d1-a3b7-6587b8944191`). Previous step: `research/2026-10-19-conversations-sdk-runtime-phase1.md`.

## Context

Phase 1 landed an `sdk` conversation runtime (`plugins/conversations/plugins/runtime-sdk`) next to `tmux`, chosen per conversation. Two exit criteria are still open:

1. **Latency.** On sdk, the time from Send to the first assistant entry is about 0.5 s slower (Haiku p50 1.62 s vs 1.14 s). The gap is inside the CLI's model request, where the CLI logs `querySource` `sdk` instead of `repl_main_thread`. The cause is unknown.
2. **Default + deletion.** New conversations still default to tmux. The UI-driving code is still there: `runtime-tmux`, the question-relay hook, the runtime `screen` facet, menu-relay and the prompt mailbox, about 6.7k lines including tests.

The user decided two things:

- **Migrate on deploy.** One idempotent boot step kills each open tmux session that this backend owns. It marks the row hibernated with `runtime='sdk'`. The next Send resumes it on sdk from the transcript. A working tmux agent loses its unfinished turn, so the push waits for a moment when none is working. Main currently has 33 non-done tmux rows: 2 working, 15 waiting, 14 hibernated, 2 gone.
- **Flip even if the gap is not ours to fix.** If the gap comes from CLI internals that no option we control can change, record the cause and the numbers, report it upstream, and continue.

Order in this session: **A** measure (the tmux baseline must be measured before tmux is deleted) → **B** explain/fix → **C** delete + migrate + flip, as one change → verify → push only when told.

## A. A repeatable before-benchmark, on both runtimes

- Extend the `latency` scenario in `runtime-sdk/bin/spike.ts` (or add a `bin/latency.ts` sibling that reuses its launch helpers) into a **two-arm, interleaved** benchmark:
  - Both arms use the same cwd (this worktree), Haiku, and N=10 turns of "Reply with exactly OK.", alternating sdk and tmux.
  - The tmux arm launches the production way: the same argv as `tmux-runtime.ts` `create`, with keystrokes via `typeTurn`. Today's tmux baseline was taken by hand, and an earlier automated attempt hit the trust dialog. That cannot happen in a trusted worktree; check that it doesn't.
- **One clock for both arms.** Each turn is measured from the CLI's own JSONL transcript: the timestamp of the user entry to the first assistant entry. This isolates the CLI and the model request from each path's delivery. Two more numbers are recorded per arm: Send → the user entry (delivery) and Send → idle (the `result` event on sdk, the touch signal / status on tmux).
- Results go to `~/.singularity/state/sdk-agents/_spike/results/latency-ab.json`, with p50 and p90 for each arm. These are the **before** numbers for the track page.

## B. Find where the 0.5 s goes

Measure first, then change one variable at a time.

1. **Split the request into phases.** Add a `--capture` mode to the benchmark that puts a small bun passthrough proxy between the CLI and the API. The proxy listens on a scratch socket or port, and `ANTHROPIC_BASE_URL` is set for both arms via `launch.json` / the env allowlist, used for diagnostics only and never committed as a default. For each request it records:
   - timings: user entry → request start (CLI-side work), request start → response headers, headers → first content SSE event, → message stop;
   - headers: `anthropic-beta`, `user-agent`, `x-app` and any query-source header;
   - body: model, `stream`, `max_tokens`, thinking/effort, `metadata`, each system block's length and hash, `cache_control` placement, tool names with each schema's hash, and message count.

   First confirm that the CLI honours `ANTHROPIC_BASE_URL` under Max OAuth. If it doesn't, fall back to the CLI's own `--debug-file` timestamps (`options.debugFile`, and `DEBUG_CLAUDE_AGENT_SDK=1` added to the allowlist).
2. **Diff sdk against tmux.** Candidate causes, from what is known:
   - **A different tool list or system prompt.** `canUseTool` adds `--permission-prompt-tool stdio`, the interactive-only sections differ, and tmux runs more hooks. This changes the prefix length or whether it hits the cache. The usage numbers in the sdk events show a 1h cache that does hit (turn 3+ creates only 67 tokens), so look for cache misses in the first turns, not steady state.
   - **Request parameters.** Streaming vs non-streaming, `max_tokens`, thinking, or betas that differ by entrypoint or `querySource`.
   - **CLI-side work before the request** that the earlier analysis counted as "inside the model call": attachments, hook runs, MCP readiness and the `stream-json` input path.
3. **Run single-variable experiments** from `launch.json`. Each is a diagnostic flag, not product code:
   - `CLAUDE_CODE_ENTRYPOINT=cli` (the SDK defaults it to `sdk-ts`);
   - `includePartialMessages` on;
   - `canUseTool` off, diagnostic only, since it removes AskUserQuestion;
   - `systemPrompt` preset with `excludeDynamicSections`;
   - matching the tool set or betas of the tmux request.
4. **Outcome.**
   - If an option we own closes the gap, apply it in `bin/agent.ts` or `server/internal/launch-options.ts`, with a comment that cites the measurement.
   - If nothing we own closes it, write up the cause and evidence and draft an upstream report for the user to send.
   - Either way, record the after numbers. The track page gets the before/after table, as its instructions require for perf tracks.

## C. sdk becomes the only runtime

### C1. Moving open tmux rows (boot step, idempotent)

- New `runtime-sdk/machine/internal/adopt-tmux-rows.ts`, run once at backend boot. It finds rows where `runtime = 'tmux'`. For each non-`done` row:
  1. It reads the session's `SINGULARITY_PARENT_HOST` with `tmux show-environment -t <id>`. It runs `tmux kill-session -t <id>` **only when that equals `runtimeNamespace()`**.
     - A worktree DB is a fork of main and holds the same conversation ids. Without this guard, a worktree backend would kill main's live agents.
     - It expects exactly the "no such session" failure and treats it as already gone. Any other failure throws.
  2. Only after that, it sets `runtime='sdk'` and `hibernated_at = coalesce(hibernated_at, now())`, with the status the hibernation job leaves (check `hibernation/server/internal/hibernate-idle-job.ts`).

  Then it sets `runtime='sdk'` on every `done` row, so forking an old conversation (which inherits the source runtime, `lifecycle.ts:231`) never asks for a runtime that no longer exists. The step kills before it updates, so a crash in between just retries on the next boot.
- The next Send goes through `ensureResumed` → `respawnResume` (`lifecycle.ts:626-698`), which now resolves to the sdk runtime with `resume: claudeSessionId`. That path takes no runtime branch. A row with no `conversations_ext_sdk_agent` row must read as "no agent yet", not crash: check `sdk-runtime.ts:219`.
- File one follow-up task to delete the step once main has no `tmux` rows. It is not deleted in this session.

### C2. Flip, and collapse the selection

With one runtime, a picker and a default are meaningless options, so they go. The `ConversationRuntime` contract and registry stay: that is the seam a future runtime plugs into.

- `tasks-core/server/internal/tables.ts:198`: column default `'sdk'`. Migration via `./singularity build`.
- Delete the `defaultRuntime` config key (`conversations/shared/config.ts:26-31`) and `resolveRuntimeId`'s config and task-option steps (`lifecycle.ts:81-93`). The explicit runtime and the fork source's runtime remain.
- Delete the `runtime-launch-option` plugin and its side table.
- `runtime-catalog/core/runtimes.ts`: drop the `tmux` entry. The `terminal` mode is always read-only, so drop the field, and drop the interactive branch in `terminal-pane-body.tsx`.
- Change the `"tmux"` literals in the demo pack (`agent-manager/plugins/demo/core/internal/pack.ts:49`) and in test fixtures (`auto-start-launch.test.ts`, `conversations-oracle.test.ts`, `edited-files-signature.test.ts`) to `"sdk"`.

### C3. Deletion

| Remove | Notes |
|---|---|
| `conversations/plugins/runtime-tmux` (whole plugin, ~5.4k lines) | Typing, screen and menu parsing, drafts, Escape/Ctrl-C, session-file and pane matching, touch signals and their data dir and prune job, global tmux hooks, launch hook settings. runtime-sdk imports nothing from it. |
| Runtime `screen` facet in `conversations/server/internal/runtime.ts` | `RuntimeScreen`, `screenOf`, `flushInteractivePrompt`, `answerTerminalMenu`, `InputNotEmptyError`, `RuntimeInfo.menu`, the terminal-menu `waitingFor` key, and `TypedTurn.cleared`. Callers: `status-reconciler.ts:421-440` (menuOpened auto-answer, plus its config), `plan-update.ts` (menu paths), and `ask-user-question/server/internal/handle-flush.ts`. |
| `conversations/plugins/menu-relay` (including `usage-limit`) and `conversations/plugins/terminal-menu` | Also the `menu` field and column in `tasks-core/core/internal/fields.ts:176` and the `prompt-input.tsx` menu use. Model-provider's own `catalog/menu.ts` is unrelated and stays. |
| question-relay hook half | `bin/ask-relay.ts`, `core/hook.ts`, `relay-hook.ts`, `waiters.ts`, the long-poll `await` endpoint, and the hook-protocol `register`/`release`/`abandon` endpoints once confirmed unused by the sdk consumer. Kept: store, holds, answer path, `onQuestionResolved`, and the web card that `runtime-sdk/machine/internal/consumer.ts` uses. |
| turn-ledger prompt mailbox | `mailbox.ts`, `promptSubmitsWatcher`, `promptSubmitHookEntry`, `reportInputNotEmpty` and the `turn-input-not-empty` report kind. Kept: `resolvePromptSubmit` and `recordPromptHookLaunch`, moved out of `mailbox.ts` if they live there. Review whether "hookless" still means anything with one runtime: if every conversation confirms through `turn_started`, delete the concept too. |
| `debug/plugins/session-divergence` | Built entirely on tmux panes and the process tree. On sdk the session id comes from `init`, so the class of divergence it detects cannot happen. |
| Adoption of hand-started tmux sessions | It went with the poller. Keep `ADOPTED_SPAWNED_BY` (`tasks-core/core/adopted.ts`) only if old rows still render it. |
| The three `boundaries/no-platform-api` debt exemptions | They are in runtime-tmux, turn-ledger (`mailbox.ts`) and question-relay (`relay-hook.ts`). Tick off debt task `task-1792338443-riwqev` if nothing else remains on it. |

Kept: `agent-launch` (the env allowlist and the compaction `SessionStart` hook, which both use), the tmux session as supervisor and viewer (`sdk-runtime.ts` has its own `tmux()` helper), and the transcript viewer, turn ledger, hibernation and workspaces.

**Docs:** update the conversations and runtime-sdk `CLAUDE.md` files, the compaction-context docs (which still say runtime-tmux), and the generated docs and registries via build. Mark the phase-1 doc's "out of scope" section as done here.

**Parity left to check during C, not built here:** the usage limit on sdk. On tmux the CLI drew a menu and `usage-limit` rendered it. On sdk it is a `result` error. Confirm that the transcript shows it and the status goes idle. If a dedicated card is wanted, file it as a follow-up.

## Critical files

- `plugins/conversations/plugins/runtime-sdk/`: `bin/spike.ts` (benchmark), `bin/agent.ts` and `server/internal/launch-options.ts` (any fix), new `machine/internal/adopt-tmux-rows.ts`, `machine/internal/sdk-runtime.ts`.
- `plugins/conversations/server/internal/`: `runtime.ts`, `lifecycle.ts`, `status-reconciler.ts`, `plan-update.ts`, `turns.ts`; `shared/config.ts`.
- `plugins/conversations/plugins/`: `runtime-catalog`, `question-relay`, `turn-ledger`, `conversation-view/plugins/terminal-pane`, `conversation-view/plugins/prompt-input`, `conversation-view/.../ask-user-question`.
- `plugins/tasks/plugins/tasks-core/server/internal/tables.ts` and `core/internal/fields.ts`.
- Deleted: `runtime-tmux`, `runtime-launch-option`, `menu-relay`, `terminal-menu`, `debug/plugins/session-divergence`.

## Verification

1. **Before the deletion lands** (A and B, on a build that still has tmux):
   - Run the A/B benchmark and record the before numbers.
   - Through the app, create one tmux conversation in this worktree and leave it idle. It is the migration test subject for C.
2. `./singularity test` on the touched plugins. New tests:
   - adopt-tmux-rows: it kills only sessions it owns (the parent-host guard), it updates the row only after the kill, and a done row's runtime is rewritten. The tmux and DB edges go behind injected functions or the worktree-db harness.
   - `resolveRuntimeId` without the config step.
3. `./singularity check`: plugin boundaries and docs/registries in sync after the deletions.
4. `./singularity build` (in the background), then on `http://<worktree>.localhost:9000`:
   - **Migration.** The tmux conversation from step 1 has no tmux session left, `runtime='sdk'` and hibernated. Sending to it resumes it on sdk with its history intact (`query_db` plus the transcript).
   - **Guard.** Main's tmux sessions are untouched by the worktree boot (`tmux ls` before and after).
   - **Default.** A new conversation from a task launches on sdk. Re-check the Phase-1 flow briefly: send, Stop, AskUserQuestion, fork, close/resume, the read-only terminal.
   - **After numbers.** Re-run the sdk arm of the benchmark if B changed anything.
5. **Before the user pushes:** check `query_db` on main for `runtime='tmux' AND status='working'`, so no live turn is cut off.

## After the session

- Track page: tick `[Latency]` and "Make it the default…". Add the before/after table, update the status, and set the next step: the Phase 2 decision, and confirming that a backend restart mid-turn holds now that sdk is the default.
- File one `add_task`: the next main track task, with the page id as context. Name the adopt-tmux-rows removal as a follow-up inside it rather than as a second task.

---

## Results (2026-10-20)

### A/B. The 0.5 s is not the runtime

Method. The CLI writes the exact request settings and timing into every
transcript: an `api-request` entry (model, betas, max_tokens, thinking, effort,
cache-control placement, `querySource`) just before each model call, and the
`assistant` entry when the reply lands. `api-request → assistant` is the model
call alone, the same clock for both runtimes. Headers and bodies were captured
with a throwaway logging passthrough (`ANTHROPIC_BASE_URL` → a local bun proxy;
the CLI honours it under the Max login). The proxy was a diagnostic and is not
committed.

What differs between interactive (tmux) and SDK requests:

- Request parameters: **identical** (same model, betas, `max_tokens` 128000,
  adaptive thinking, effort, the same 1-hour cache breakpoints).
- Headers: only `user-agent` (`external, cli` vs `external, sdk-ts`).
- System prompt: block 0 is a billing header carrying `cc_entrypoint=cli` vs
  `sdk-ts`; block 1 is the identity line ("You are Claude Code…" vs "You are a
  Claude agent, built on Anthropic's Claude Agent SDK."). A non-interactive
  CLI picks the SDK identity unless the session recorded another one.
  `CLAUDE_CODE_ENTRYPOINT=cli` does not change it: print mode becomes
  `sdk-cli`.
- The interactive prompt is larger (Artifact / Chrome sections, 2 more tools).

Measurements (Haiku, time to response headers or to the first assistant
entry, p50):

| run | interactive (tmux) | SDK / print mode |
|---|---|---|
| Phase 1, one session each, 8 turns, run concurrently | 1.14 s | 1.62 s |
| prod transcripts, concurrent sessions in two scratch workspaces | 0.95 s | 1.50 s |
| print mode only, two concurrent sessions in a scratch dir (both entrypoints) | — | 1.41 s / 1.48 s |
| same cwd, interleaved: interactive vs `claude -p` | **1.10 s** | **1.07 s** |
| same cwd, interleaved: interactive vs the real agent (`spike.ts latency-ab`), 3 runs (one fresh session per arm each) | 1.50 / 1.16 / 1.14 s | 1.04 / 1.60 / 0.99 s |
| the same 3 runs pooled (30 / 33 requests) | **1.29 s** | **1.14 s** |
| resumed sessions in the worktree, `claude -p`, SDK identity vs recorded CLI identity | 1.13 s | 1.02 s |

Conclusion: the latency is set **per session**, not per runtime. Within one
session the requests sit consistently fast or slow, and two concurrent sessions
of the same runtime differ as much as the two runtimes did in Phase 1: across
three interleaved runs, one sdk session sat at 1.60 s and one tmux session at
1.50 s, while the others sat near 1.0–1.15 s, and pooled the sdk agent is
slightly faster. The likeliest cause is server-side cache
locality (each session's cached prefix lives where it lives), but that is
outside what a client can observe. Nothing in the SDK path costs model-request
time, so there is nothing to fix on our side; per the user's call, sdk becomes
the default.


### Cold start and the one 32 s stall

On the first conversation launched after the flip (`conv-1792453660-tcjl69`,
right after the worktree's build restarted its backend), the second turn
reached the CLI 32 s after the agent passed it on; it went in the moment the
transcript recorded `deferred_tools_delta` / `mcp_instructions_delta`, so the
CLI held the queued turn until its MCP servers were up. It did not recur:

| run (this checkout, Haiku) | launch → prompt 1 in transcript | launch → reply 1 | send → prompt 2 in transcript | send → reply 2 |
|---|---|---|---|---|
| `spike.ts cold-start`, sdk agent, round 1 / 2 | 3.8 / 3.5 s | 5.5 / 7.5 s | 18 / 20 ms | 1.6 / 1.3 s |
| `spike.ts cold-start`, interactive tmux, round 1 / 2 | 0.7 / 0.7 s | 10.9 / 7.9 s | 0.33 / 0.32 s | 2.9 / 1.5 s |
| through the server (`POST /api/conversations`, production MCP config) | — | 6.1 s (from the create call) | 27 ms | 1.6 s |
| `conv-1792453660-tcjl69`, a third turn hours later | — | — | 9 ms (agent → CLI) | 1.9 s |

The interactive CLI writes the prompt to its transcript sooner but answers no
sooner (7.9–10.9 s to the first reply, against 5.5–7.5 s). The stall looks
like a CLI wait on MCP startup, seen once, right after a backend restart (the
Singularity MCP server is that backend); not reproduced in five launches since. (A 2.5 s
send → agent gap on the third turn was the worktree backend being started on
demand by the gateway, ready 114 ms before the turn reached the agent.)
