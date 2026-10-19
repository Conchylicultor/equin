# SDK Claude — spike: a standalone Agent-SDK agent process

Track: wiki *Mental model → Agent Manager → SDK Claude* (`block-3005117a-178e-45d1-a3b7-6587b8944191`), vision sub-page `block-b2dd6371-cd50-4298-9b88-2898ae1382f8`.

## Context

Today the tmux runtime (`plugins/conversations/plugins/runtime-tmux/server/internal/tmux-runtime.ts`) drives the interactive CLI by keystrokes and screen reading. The vision proposes one detached bun process per conversation, which wraps the Agent SDK's `query()`, takes commands over a Unix socket and writes every SDK message to an append-only `events.jsonl`. Before building Phase 1 (an `sdk` `ConversationRuntime`), five questions need a yes or no from running code:

1. Does it survive a backend restart mid-turn without losing events, including a pending question?
2. Does `canUseTool` still fire for AskUserQuestion under `bypassPermissions`? If not, does an in-process `PreToolUse` hook callback work?
3. Does it run on the Max subscription login (keychain, no `ANTHROPIC_API_KEY`), inside the `env -i` allowlist we use today?
4. Can it rewind to a given message (`resume` + `resumeSessionAt`, `forkSession`, `rewindFiles`)?
5. Can a human inspect it from the terminal button?

Plus measured latency against the tmux baseline.

What we already know from reading the code and the SDK:

- SDK `@anthropic-ai/claude-agent-sdk@0.3.303` matches the installed CLI 2.1.303. It exposes `resumeSessionAt`, `resumeDropsTurn`, `forkSession`, `enableFileCheckpointing` / `rewindFiles`, `interrupt`, `setModel`, `streamInput`, `accountInfo`, `includePartialMessages` and `canUseTool` (`sdk.d.ts`). The d.ts states that `resumeSessionAt` is honoured only on the print/SDK lane, which matches the comment at `plugins/conversations/server/internal/lifecycle.ts:746`.
- Terminal button: `terminal-pane/web/components/terminal-pane-body.tsx:26` runs `tmux -u attach -t <conversationId>` through `/ws/terminal` (`primitives/terminal`). A tmux session named after the conversation id therefore works unchanged.
- Auth today: nothing is passed. The CLI reads the keychain login through `HOME`, which is in the allowlist (`runtime-tmux/server/internal/agent-session-env.ts`).
- Today the question relay is a PreToolUse hook script that long-polls (`question-relay/bin/ask-relay.ts`).

## Approach

The spike code goes in the repo as the seed of the Phase 1 plugin. It is not wired into any runtime or UI yet.

`plugins/conversations/plugins/runtime-sdk/`
- `package.json`: pins `@anthropic-ai/claude-agent-sdk` to `0.3.303` exactly.
- `core/protocol.ts` (+ barrel `core/index.ts`): zod schemas for socket commands (`hello{version}`, `turn{text}`, `interrupt`, `answer{requestId, answers}`, `setModel`, `shutdown`) and for the event line envelope `{seq, t, kind: "sdk" | "permission_request" | "agent", payload}`. `PROTOCOL_VERSION = 1`. This follows the `packages/resource-protocol` precedent.
- `bin/agent.ts`, the agent process (a few hundred lines):
  - Flags: `--id --cwd [--resume <sid>] [--resume-at <uuid>] [--fork] [--model]`.
  - Runs `query()` in streaming-input mode, with input from an async queue fed by the socket. Options: `permissionMode: "bypassPermissions"`, `canUseTool`, `hooks.PreToolUse` (the fallback, armed only if the experiment needs it), `includePartialMessages: true`, `enableFileCheckpointing: true`, `cwd`.
  - Writes every SDK message unchanged to `~/.singularity/state/sdk-agents/<id>/events.jsonl`, one numbered line each, through a `defineFileSink` (no fsync: the page cache outlives a crashed process).
  - `canUseTool` writes a `permission_request` event and parks a promise. A later `answer` command resolves it with `updatedInput`.
  - Listens on `~/.singularity/sockets/agents/<id>.sock` (`--socket`). The path stays well under the 104-byte macOS limit with conversation ids; it cannot sit next to `events.jsonl` (see Findings).
  - Prints a human-readable log to stdout: assistant text, `tool: Bash(…)`, results truncated, `? question`, `● idle`.
- `bin/spike.ts <scenario>`, the harness, run with `./singularity run`. It includes a tiny observer that stands in for the backend:
  - It tails `events.jsonl` with `fs.watch`, keeping a cursor file in place of the DB row, and sends commands over the socket.
  - It launches the agent the way production will: `tmux new-session -d -s <id> -c <cwd>`, wrapped in an `env -i` allowlist equivalent to `AGENT_SESSION_WRAPPER`, running `bun bin/agent.ts …`.
  - Each scenario writes a JSON result into `~/.singularity/agents/_spike/results/`.

Scenarios, one per question:

| # | Scenario | Pass criterion |
|---|---|---|
| 1 | **restart**: the turn is "run `sleep 20` via Bash, then reply DONE". After about 5 s, `kill -9` the observer. Restart it from the cursor. Repeat with an AskUserQuestion pending while the observer is down: the restarted observer must see the `permission_request` again during replay and answer it. Also `kill -9` the agent process itself and check that `--resume <sid>` continues the conversation. | Seq numbers have no gaps, `result` is received, the question is answered after the restart, and the agent process is not a child of the observer (`ps -o ppid`) |
| 2 | **ask**: a prompt that forces AskUserQuestion under `bypassPermissions` | Record whether `canUseTool("AskUserQuestion")` fires. If it does not, the `PreToolUse` callback returning `updatedInput` must deliver the answer, and the model must echo the chosen option |
| 3 | **auth**: run with `ANTHROPIC_API_KEY` unset, under the allowlist env | `accountInfo()` and `system/init.apiKeySource` show the claude.ai / Max login, and the turn succeeds |
| 4 | **rewind**: turn A "remember APPLE", turn B "remember BANANA and write `x.txt`". Then (a) `resume` + `resumeSessionAt` at A's last uuid (+ `resumeDropsTurn`), asking "which words?"; (b) the same with `forkSession: true`; (c) `rewindFiles(B's user uuid)` | (a) only APPLE; (b) a new session id, with the original JSONL unchanged; (c) `x.txt` is removed |
| 5 | **terminal**: open the agent's tmux session through the real `/ws/terminal` socket on this worktree's build (`session.create` with `tmux -u attach -r -t <id>`), and also `tmux capture-pane -p` | The readable log is visible and read-only, and the agent is not disturbed |
| 6 | **latency**: N=5 trivial turns ("reply OK"), on a cold start and a warm session | Spawn → `init`, Send → first `stream_event` token, Send → first assistant message, Send → `result` (p50 / max) |

Tmux baseline for latency: read-only from main's DB (`query_db`): `conversation_turns.submitted_at − created_at` (Send → the CLI accepted the turn) over the last ~200 turns. For a sample of those, also Send → first assistant entry, taken from the transcript JSONL timestamps. Same metrics wherever they map.

## Outputs

- Wiki:
  - A new agent sub-page *Spike results* under the track: per-question verdict, evidence, gotchas and the latency table.
  - The track header card updated: status, the Spike checkbox, measured latency, the next step (Phase 1, adjusted by the findings, e.g. the PreToolUse fallback if `canUseTool` does not fire).
  - Answers to the matching Vision open questions.
- One `add_task` for the next main step (Phase 1), with the page id as context, per the track instructions.
- Code stays on the branch for review. No push.

## Verification

- `./singularity run plugins/conversations/plugins/runtime-sdk/bin/spike.ts <scenario>` for each scenario. The results JSON files are the evidence quoted on the wiki.
- `./singularity build` (run in the background), to confirm the new plugin passes checks (boundaries, docs in sync) and to give scenario 5 a build to drive.
- `tail -f ~/.singularity/agents/<id>/events.jsonl` and `tmux attach -r -t <id>` by hand, as a sanity check.

## Findings (2026-10-19)

All five questions: **yes**. Evidence: `~/.singularity/state/sdk-agents/_spike/results/*.json`, from `bin/spike.ts <scenario>`. Functional scenarios ran on Haiku; latency ran on the default model (Opus 5.5, 1M context).

| Question | Verdict | Evidence |
|---|---|---|
| Backend restart mid-turn | **Yes** | The backend stand-in was SIGKILLed 1 s into a 20 s Bash call. The turn finished while it was down. The restarted observer resumed from its cursor: events 2–35, none missing, no duplicates. With an AskUserQuestion open, the restarted backend's `hello` listed the 1 open request, it answered over the socket, and the agent replied "Blue". The agent's parent is the tmux server (whose parent is launchd), never the backend. |
| Agent process killed | **Yes** | SIGKILLed the agent, then `--resume <sid>` in a new process continued the same session ("which color?" → Blue). The event numbering stayed gap-free across both processes (1–91). |
| AskUserQuestion under `bypassPermissions` | **Yes, via `canUseTool`** | The request arrived 2.8 s after Send. The answer came back as a real tool result: `"Which color?"="Blue"`. The SDK prints a misleading warning ("canUseTool will not be invoked… bypassPermissions"), but it fires for AskUserQuestion. **Without `canUseTool`, the CLI removes AskUserQuestion from the tool set** (the model says "the AskUserQuestion tool isn't available"), so the in-process PreToolUse fallback is not an option. |
| Max subscription | **Yes** | `accountInfo()` returned `subscriptionType: "Claude Max"` and `apiProvider: firstParty`. `init.apiKeySource` was `none`. There was no `ANTHROPIC_API_KEY` and no `CLAUDE_CODE_OAUTH_TOKEN` in the agent's `env -i` environment: the CLI found the keychain login through `HOME`, exactly as in tmux. |
| Rewind to a message | **Yes** | `resume` + `resumeSessionAt` (A's last assistant uuid) + `resumeDropsTurn` (B's prompt uuid) answered "APPLE" only. It kept the same session id and appended a new branch to the same JSONL. `forkSession: true` at the same point answered "APPLE" in a new session and left the original JSONL untouched. `rewindFiles(B's prompt uuid)` removed the `x.txt` that B wrote. Prompt uuids are minted by the agent (`SDKUserMessage.uuid`), so the backend knows them without reading the transcript. |
| Terminal button | **Yes** | The button's exact path (main's `/ws/terminal`, `tmux -u attach -r -t <id>`) shows the readable log: prompt, `⏺ Bash {…}`, `⎿ hello-from-bash`, reply, `● idle · success · 2360 ms · $0.0029`. The agent kept serving after a viewer attached and detached. |

### Latency (5 trivial turns "Reply with exactly OK.", warm, p50 / min–max)

| Path | Send → first token | Send → turn end | Spawn → ready |
|---|---|---|---|
| SDK agent, this worktree (full harness: CLAUDE.md, hooks, MCP) | 1.57 s (1.40–2.07) | 1.58 s | 3.4 s |
| SDK agent, scratch dir | 1.89 s (1.84–3.07) | 1.91 s | 0.86 s |
| tmux, interactive CLI, `send-keys` straight in (no app) | 1.20 s (1.17–1.47), first transcript entry | n/a | ~10 s (boot plus waiting for the input box) |
| tmux runtime, app path: Send → CLI accepted (ledger, main, last 28 turns) | +0.27 s p50, +0.71 s p90 before the model even starts | | |

- **Measurement caveats:**
  - The tmux row is the transcript's own timestamp for the first assistant entry. That entry is written when the first content block completes, so for a two-token reply it coincides with the first token.
  - The SDK rows are stamped when the agent writes the event, after the SDK delivered the message.
  - The tmux row was measured by hand: an interactive CLI in tmux, `send-keys`, the transcript's timestamps. An automated version tripped over the interactive "trust this folder?" dialog in a fresh dir, which the SDK lane never shows.
- **Read:**
  - Model time to first token is the same on both paths, within noise.
  - The SDK's win is not raw first-token time. It is the removal of the app-side typing and confirmation path (+0.27 s p50 and +0.71 s p90, plus retries), and the busy/idle status: `result` is an exact event, with no guessing.
  - Startup is about 3.4 s to a session ready for a turn, against tmux's boot plus waiting for the input box.
  - Token-level streaming is available (`stream_event` deltas) and the JSONL never had it.

### Gotchas found

- **Socket next to the events file breaks the watcher.** A kqueue watch (`writesWhileOpen`) of the agent's directory opens every entry, and `open(2)` on a Unix socket fails with EOPNOTSUPP. The socket therefore lives in the sockets dir (`sockets/agents/<id>.sock`), as the vision proposed.
- **`fs.watch` under bun never reports appends** to a file, from the same process or another. The backend must use the file-watcher engine (`defineFileWatcher` with `writesWhileOpen`).
- **Starting and stopping a native watch per wait crashed bun 1.4.3** (segfault) in the harness. The fix was one subscription per directory. Phase 1's `defineFileWatcher` instance per conversation already has that shape.
- **The SDK bundles its own CLI binary** (`@anthropic-ai/claude-agent-sdk-darwin-arm64`, 268 MB, as an optional dependency), pinned to the SDK version (0.3.303 → 2.1.303). `pathToClaudeCodeExecutable` can point at the system `claude` instead. Phase 1 must decide which.
- **The launch environment must carry the same `-e` variables as runtime-tmux.** In the worktree run the `equin` MCP server showed `failed`, because `.mcp.json` interpolates `SINGULARITY_PARENT_HOST` and `SINGULARITY_CONVERSATION_ID`, which the spike's `env -i` left out. This is a launch detail, not an SDK limit.
- **`system/init` is emitted with the first turn, not at spawn.** Readiness is `hello` (which awaits `accountInfo()`, i.e. the CLI's initialize).
- **A truncating resume of the same session appends a branch to its JSONL.** The old entries stay, so the transcript viewer must follow the `parentUuid` chain from the leaf, as it already does for interactive `/rewind`.
- **Every process that exits on a session appends a `cost-state` line to its JSONL**, the fork's source included. Counting user/assistant entries, the original stayed at 9 across the fork. Anything that compares transcripts must skip bookkeeping lines.
- **Main's tmux poller adopts any tmux session whose cwd is inside a worktree.** It files the session as a `tmux` conversation under that worktree's attempt. Three spike sessions (`spike-latency-worktree-default-model`, `spike-tmux-baseline`, `spike-dbg`) showed up on main as conversations with no transcript. Phase 1 must teach the poller about `sdk` agents (skip them, or attach them to their own conversation row) before an SDK agent runs in a worktree.
- **`events.jsonl` must be a declared file sink** (lint `no-adhoc-file-sink`), and `defineFileSink` rotates at 128 MB. A backend replaying from a cursor would miss lines that moved to `events.jsonl.1`. Phase 1 must make rotation and replay agree, for example with a cursor of (file, seq) or a sink that never rotates the live conversation.
- **The harness never exited after a scenario.** Its per-directory watchers held bun's event loop open, and a `restart && rewind` chain sat idle for 8 h after `restart` passed. `bin/spike.ts` now stops the watchers and exits, with a 10-minute ceiling per scenario.

### Next step

Phase 1: an `sdk` implementation of `ConversationRuntime` in this plugin, beside tmux, selectable per conversation.
- Launch in tmux with runtime-tmux's environment allowlist and `-e` variables.
- Turns, Stop (`interrupt`) and AskUserQuestion go over the socket, through `canUseTool` into the existing `pending_questions` form.
- Busy/idle comes from `result` events read through a `defineFileWatcher` on `events.jsonl`, with a DB cursor.
- The UI keeps reading the JSONL.
