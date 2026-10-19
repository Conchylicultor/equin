# SDK Claude — Phase 1: an `sdk` conversation runtime beside tmux

Track: wiki *Mental model → Agent Manager → SDK Claude* (`block-3005117a-178e-45d1-a3b7-6587b8944191`). Vision: `block-b2dd6371-…`. Spike results: `block-a23ab941-…`. Spike notes: `research/2026-10-19-conversations-sdk-agent-spike.md`.

## Context

The spike showed that one standalone agent process per conversation works: `plugins/conversations/plugins/runtime-api/bin/agent.ts` wraps the Agent SDK's `query()`, takes commands over a Unix socket and writes every SDK message to a numbered `events.jsonl`. It survives backend restarts, intercepts AskUserQuestion under bypass, runs on the Max login and can rewind.

Conversations still can't use it: `runtime-api` registers a stub `ConversationRuntime` (`id: "api"`) that throws. Phase 1 makes it a real `sdk` runtime, selectable per conversation. tmux stays the default. The UI keeps reading the CLI's JSONL transcript.

**Out of scope, next session:** flipping the default and deleting the UI-driving code and the question relay. That waits until real conversations have run on sdk and no tmux-run conversations remain.

## Decisions

- **CLI binary: the system `claude`** (confirmed by the user). It is passed as `pathToClaudeCodeExecutable: requireClaudeBin()`, the same binary tmux runs.
  - Then transcripts, `claude --resume` and the availability gating are shared with tmux conversations, and a conversation can fork across runtimes.
  - Drift guard: the agent's `hello` reports the CLI's version (from `system/init`, `claude_code_version`) beside the SDK's pinned version. A `HealthReport.Row` goes to `attention` when their major.minor differ.
  - Pin the SDK exactly in `package.json` (it is `^0.3.303` today; the spike doc claims an exact pin).
- **Stop = interrupt + rewind the turn**, the same as tmux. If no reply arrived, the turn is dropped and its text goes back to the composer. The rewind restarts the agent with `resume` + `resumeSessionAt` + `resumeDropsTurn`. The transcript is never truncated under a live CLI.
- **Scope:** the runtime and per-conversation selection. A `conversations.defaultRuntime` config key stays on `tmux`.

## Design

### 0. Rename `runtime-api` → `runtime-sdk`, id `api` → `sdk`

- Done with `./singularity plugin move`. This makes it symmetric with `runtime-tmux`.
- No rows use `api` (the stub could never create one). Check with `query_db` before renaming.

### 1. Make the runtime contract stop assuming an input box

This is rung 1 of the coding-style ladder: the SDK runtime should have nothing tmux-shaped to stub out. Changes to `plugins/conversations/server/internal/runtime.ts`:

- **`stop(id): Promise<{ returnedText: string | null }>`** replaces the choreography `stopTurn` runs in `server/internal/turns.ts:242`: interrupt → `rewindConversationTurn` → `clearInput({awaitRestore})`.
  - tmux moves that exact sequence into its own `stop`.
  - `stopTurn` keeps only the shared parts: `withTerminal`, then `returnTurnByText` on the result.
- **An optional `screen` facet** holds the methods that exist only for a terminal UI: `clearInput`, `flushInteractivePrompt` and `answerMenu`.
  - Their callers (status-reconciler `menuOpened`, ask-user-question `handle-flush`, menu-relay) use the facet. When a runtime has none, the call throws loudly; it cannot happen, since only a screen runtime reports a menu.
  - The facet is exactly what the deletion phase removes.
- **`TypedTurn.cleared` becomes optional**, documented as "absent: this runtime has no input box". The ledger's `noteClearedDraft` skips it when it is absent. A runtime without an input box then has no fake `""` to report.
- **`LaunchFragment` becomes typed** (`plugins/conversations/plugins/workspace/server/internal/registry.ts:12`).
  - Today `argv` holds CLI flags (scratch: `--setting-sources`, `--mcp-config`, `--strict-mcp-config`). Those would collide with the SDK's own `settingSources` and `mcpServers` options.
  - New shape: `{ settingSources?, mcpServers?, strictMcpConfig?, settings }`. tmux renders it to argv, the SDK to options. `scratch/launch-fragment.ts` is updated to match.

### 2. Shared launch pieces → a new `conversations/plugins/agent-launch` (server)

Both runtimes need these, but they live in `runtime-tmux/server/internal`:

- From `agent-session-env.ts`: the `env -i` allowlist wrapper and the `-e` variables (`SINGULARITY_CONVERSATION_ID`, `SINGULARITY_PARENT_HOST`, `CLAUDE_CODE_DISABLE_AGENT_VIEW`). The spike's MCP failure came from leaving these out.
- From `launch-settings.ts`: `mergeLaunchSettings` and `LAUNCH_CLI_SETTINGS`.
- The compaction hook entry.
- The tmux-only touch-signal hooks stay in `runtime-tmux`.
- The relay and prompt-submit hooks are not used by sdk (see §4 and §5).

The file moves also clear part of `runtime-tmux`'s `no-platform-api` exemption debt, wherever they move.

### 3. Launch and liveness (`runtime-sdk/server`)

- **`create`** runs `tmux -u new-session -d -s <convId> -c <cwd>` with the shared env wrapper. The command is `bun <repo>/plugins/conversations/plugins/runtime-sdk/bin/agent.ts --id … --cwd … [--resume] [--fork] [--resume-at] [--resume-drops-turn] [--model] [--effort] --claude-bin <system claude>`.
  - The launch options (settings fragment, setting sources, MCP config, effort, `ultracode` settings) go to the agent as one JSON file in its state dir. That avoids shell-quoting a large settings object.
  - The prompt is the first `turn` over the socket once `hello` succeeds. No temp file and no argv.
  - The tmux session gets the user option `@singularity-host sdk`. It is named after the conversation id, so the terminal button keeps attaching to it.
- **The tmux poller must not adopt it.** `parsePaneRows` (`runtime-tmux/server/internal/pane-rows.ts:70`) skips any pane whose session carries `@singularity-host` (added to the `list-panes` format).
  - The rule is generic: "hosted by another runtime". tmux names no other runtime.
  - This also fixes the spike sessions that main adopted.
- **Liveness:** "does the socket accept `hello`?".
  - `isRunning` and `inspect` connect to `sockets/agents/<id>.sock`, sending at most one `hello` per id and reconcile, in parallel.
  - `ECONNREFUSED` or `ENOENT` means dead. Any other error throws, which the reconciler reads as unknown.
  - `list()` is `inspect()` over this DB's non-closed `sdk` rows: no host-wide scan and no orphans to adopt.
- **`waitUntilReady`:** wait (bounded) until `hello` succeeds. The spike found that `init` only arrives with the first turn.
- **`delete`:** a `shutdown` command, then `tmux kill-session`. It is idempotent.

### 4. Events → state (the consumer)

- **Watching:** one `defineFileWatcher` (`writesWhileOpen`) over `state/sdk-agents/`, started in `subscribe()`. It filters to the ids of this DB's `sdk` conversations.
- **Cursor and projection:** a new side table `conversations_ext_sdk_agent`, built with the entity-extensions primitive the way `spawn-failure` does it. Columns: `cursor_seq`, `session_id`, `working`, `status_at`, `cli_version`, `open_request_id`, `last_prompt_uuid`, `last_assistant_uuid`.
- **Applying lines:** each new line is applied in one transaction that also advances the cursor, then signals `{conversationIds:[id]}`.

| Event | Effect |
|---|---|
| `sdk` `system/init` | `session_id` → `RuntimeInfo.claudeSessionId`, so the existing session gate and chain take over unchanged |
| `agent` `turn_started` (new: emitted when the input generator yields the turn, with `promptUuid` and text) | `working=true`, `status_at=t`; `resolvePromptSubmit(id, text, t)` (export it from `turn-ledger/server`) confirms the ledger turn without the mailbox hook. `create` calls `recordPromptHookLaunch` so the conversation is not treated as hookless. |
| `sdk` `assistant` | records `last_assistant_uuid` (the rewind anchor) |
| `sdk` `result` | `working=false`, `status_at=t` |
| `permission_request` (AskUserQuestion) | see §5 |
| `agent` `exited` | dead, which the next `hello` also confirms |

- **Rotation:** `defineFileSink` keeps rotating at 128 MB.
  - The reader reads the generations `.N … .1`, then the live file, and skips `seq ≤ cursor`.
  - A gap in `seq` (more than `keep` generations missed) files a report instead of silently skipping. Rotation and replay then agree without an unbounded sink.
- **`RuntimeInfo`** carries `working` and `statusWrittenAt=status_at` from the table, `dead` from `hello`, `menu: null`, `waitingFor: null` (questions arrive through `QuestionHolds`), and `title: ""` (uninformative).

### 5. AskUserQuestion through `canUseTool` into the existing form

- **Registering the question:** on a `permission_request`, the consumer calls question-relay's `registerQuestion(convId, {toolUseId, questions, pid})` (`question-relay/server/internal/store.ts:56`, exported).
  - `toolUseId` comes from `canUseTool`'s `options.toolUseID`, carried in the event.
  - The open hold already makes the conversation `waitingFor: "question"`, and the web form is unchanged.
- **Delivering the answer:** question-relay gets a generic in-process listener, `onQuestionAnswered(cb)`. Today its waiters only serve the hook's long poll.
  - The sdk runtime turns `toCliAnswer` (`{answers, annotations?, response?}`) into an `answer` socket command.
  - `agent.ts` resolves `canUseTool` with `updatedInput: {...input, ...answer}`.
- **After a backend restart:** at boot, every open request listed by `hello.openRequests` is matched against its `pending_questions` row. An answered row is delivered again; an open one waits for its answer.
- **`answerPrompt(text)`, a reply instead of an answer:** a new `dismiss{requestId}` command resolves `canUseTool` with `deny` + `interrupt: true`. Then the text goes as a normal turn.
- Every other tool returns `allow`. Bypass mode stays on.

### 6. Turns, Stop, fork, rewind, model, effort, hibernate

- **`send`:** a `turn` command. It resolves `{verdict: submitted}` once the agent acknowledges it, and the ledger confirms the turn on `turn_started`. The agent never needs `withTerminal`, but keeping it is harmless.
- **`stop`:**
  1. `interrupt`, then wait for the `result`.
  2. If the interrupted turn has no assistant reply (the same rule as `rewindLastUserTurn` in `server/internal/claude-transcript.ts`; check it during implementation), `shutdown` the agent and relaunch it with `--resume <sid> --resume-at <last_assistant_uuid> --resume-drops-turn <promptUuid>`.
  3. Return the text.

  The relaunch appends a branch to the JSONL, and the viewer follows `parentUuid` from the leaf. Verify that it does.
- **Fork, rewind in place, hibernate and resume** keep their shared mechanisms: a transcript copy or cut followed by `create({resumeSessionId, forkSession})`, and `respawnResume`. They already work for any runtime whose `create` honours `resume` and `fork`, which `agent.ts` does.
  - Fork and resume inherit the source row's runtime. Today `forkFrom` drops it, which is a bug for sdk; fix it in `prepareConversation`.
- **Model and effort** are passed at create and resume, as today. There is no in-place model-switch UI, so `setModel` stays an unused agent command until one exists.

### 7. Selection per conversation

- A `conversations.defaultRuntime` config key (`tmux` | `sdk`, default `tmux`) replaces `DEFAULT_RUNTIME` in `lifecycle.ts:74`.
- A **Runtime** launch option, contributed to `tasks.launch-option` by the same pattern as `task-effort`, lists `Runtime.all()` ids. It flows into `createConversation`'s existing `body.runtime`.
- **Terminal button:** for an `sdk` row, `terminal-pane-body.tsx:26` attaches read-only (`tmux attach -r`). Otherwise a Ctrl-C typed into the pane would SIGINT the agent and its CLI.

### 8. agent.ts hardening (from spike to production)

- Remove the `--ask preToolUse` experiment.
- Options come from the JSON file (§3), plus `settings`, `settingSources`, `mcpServers`, `effort` and `extraArgs` mapped from the typed `LaunchFragment`.
- Emit `turn_started` from the input generator.
- Add a `dismiss` command, and add `cliVersion` to `hello`.
- Ignore SIGINT; exit through `shutdown` only.
- `bin/spike.ts` stays as the experiment harness, pointed at the renamed plugin.

## Critical files

- `plugins/conversations/server/internal/runtime.ts`, `turns.ts`, `lifecycle.ts`, `status-reconciler.ts`: the contract, Stop, the default runtime and the screen facet.
- `plugins/conversations/plugins/runtime-tmux/server/internal/tmux-runtime.ts`, `pane-rows.ts`, `launch-settings.ts`, `agent-session-env.ts`: `stop`, the `@singularity-host` skip, and the moves.
- `plugins/conversations/plugins/runtime-sdk/` (renamed): `server/internal/sdk-runtime.ts`, `consumer.ts`, `socket-client.ts`, `tables.ts`; `bin/agent.ts`; `core/protocol.ts` (`turn_started`, `dismiss`, `toolUseId` on `permission_request`, protocol v2).
- `plugins/conversations/plugins/question-relay/server`: export `registerQuestion`, add `onQuestionAnswered`.
- `plugins/conversations/plugins/turn-ledger/server`: export `resolvePromptSubmit`.
- `plugins/conversations/plugins/workspace/`: the typed `LaunchFragment`.
- New `plugins/conversations/plugins/agent-launch/`.
- `conversation-view/plugins/terminal-pane/web/components/terminal-pane-body.tsx`: the read-only attach.

## Verification

- `./singularity test` on the touched plugins. New unit tests:
  - the consumer's reducer: event lines → table rows, including a rotation-gap report and replay from a cursor;
  - `parsePaneRows` skipping `@singularity-host`;
  - the `LaunchFragment` rendering for both runtimes.
- `./singularity build` (in the background). Then, on `http://<worktree>.localhost:9000` and through the `browser_*` tools, a conversation launched with Runtime = sdk in a scratch workspace:
  - send → busy → idle;
  - AskUserQuestion answered from the web form;
  - "reply instead" on an open question;
  - Stop before a reply (the text comes back, and the transcript shows no dropped turn);
  - Fork from a message;
  - hibernate and resume;
  - the read-only terminal button.
- Restart test: a backend restart mid-turn (`./singularity build` while a `sleep 20` Bash runs) and while a question is open. The turn completes, the cursor replays without gaps, and the question form reappears and can be answered.
- Before/after latency for the track's exit criteria: Send → first assistant entry, and Send → idle status in the DB, on sdk versus tmux. The numbers go on the track page.
- `query_db` on main: no new `tmux` rows adopted from sdk sessions.

## After the session

- Update the track header card: tick the Phase 1 items that landed.
- File one `add_task` for the next step (flip the default, then delete the UI-driving code and the relay), with the page id as context.
