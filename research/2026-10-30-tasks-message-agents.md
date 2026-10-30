# Messaging the agents of a task tree (orchestration/message)

Task: `task-1793316881-e8ku9g`. Follows `research/2026-10-29-tasks-autonomous-run-mode.md`, which listed "messaging a worker from the supervisor" as out of scope.

## Context

A supervisor's workers report back to it as event turns (watch), but it cannot answer them. No MCP tool sends a turn to another conversation, and no tool lists which conversations run in its tree. Claude Code's own `SendMessage` / `ListAgents` only see sessions it spawned itself, not app-launched workers. So after a report the supervisor cannot say "push it", "fix X first" or "redo". That breaks the review → approve loop.

Outcome: two MCP tools, granted by a new mandate capability:

- `list_agents`: the agents in my mandate's tree and how each stands.
- `message_agent`: send one of them a turn. It arrives now. A stopped agent is resumed first.

## User decisions (2026-10-30)

- **Inject now.** A message is typed in the same way a user turn is. A busy worker's CLI folds it into the running turn at its next tool boundary. A held AskUserQuestion is withdrawn by it, as `submitTurn` does for any non-answer turn. There is no store and no hold-until-idle.
- **Whole mandate tree.** Any task under the caller's mandate root (siblings and the supervisor included) is in scope, except the caller's own conversation.

## Plugin layout

```
plugins/tasks/plugins/orchestration/plugins/message/     # NEW, names no workflow
  plugins/capability/core   messageTree = defineCapability<true>({ id: "message.tree", label: "Message the agents in its tree" })
  server/                   Mandate.Capability describe; list_agents + message_agent (Mcp.tool, when: granted(messageTree))
    internal/agents.ts      treeAgents(conversationId): the tree's tasks × their latest conversation
    internal/send.ts        sendAgentMessage(from, to, text) → outcome union
    internal/tools.ts
    internal/agents.test.ts (worktreeDbScenario)
plugins/tasks/plugins/mandate-presets/core/internal/presets.ts   + messageTree.grant(true) in supervisorMandate's shared grants
```

The capability lives in a leaf sub-plugin, the same shape as `watch/plugins/capabilities` and `self-compact/plugins/capability`. It lets mandate-presets grant it without a cycle through `conversations`.

Import DAG: `message/server` → `tasks-core/server`, `orchestration/mandate/server`, `conversations/server` (`submitTurn`, `resumeConversation`, `ResumeBlockedError`), `infra/mcp/server`, `database`. Nothing imports `message/server`, so there is no cycle (the same edges as `watch`).

## 1. Scope: `treeAgents(conversationId)`

- `getConversation(caller)` → `mandateOf(taskId)`. A mandate of kind `none` means no tree: the tool answers that.
- One SQL read: a recursive CTE down `tasks.folder_id` from `rootTaskId` (as `tree-digest/store.ts` `readSubtree`), joined to `attempts` → `conversations`. It keeps the latest conversation per task (`DISTINCT ON (task_id) … ORDER BY created_at DESC`) and parses rows with `executeRows` and zod.
- Row: `taskId, title, conversationId, status, waitingFor, hibernated, statusUnverifiedSince, updatedAt`, plus `self` when the row is the caller's own conversation.

## 2. `list_agents` ()

One line per task in the tree that has a conversation, indented like the digest:

```
task-… "Title" · conv-… · working | idle | waiting on the user | hibernated | stopped (gone) | closed (done) [· status unverified] [· you]
```

Tasks with no conversation yet are left out, since `task_tree` shows them. If the tree holds no agent, it says so.

## 3. `message_agent` ({ to, text })

- `to` is a task id (it resolves to that task's latest conversation, which is what event turns name) or a conversation id. The kind is recognised by `taskIdKind` / `conversationIdKind` (`tasks/task-ids`).
- The tool refuses, with a tool error and the reason, when:
  - the target is not in the caller's tree;
  - the target is the caller's own conversation;
  - the task has no conversation yet ("file / start it instead").
- The tool resumes, then sends:
  - status `gone` / `done`: `resumeConversation(id)` (the resume plugin's path; it clears task hold/drop). The status becomes `starting`, so the turn is held and delivered once the agent is up.
  - a blocked resume (`ResumeBlockedError`, e.g. the checkout was reclaimed) is a tool error carrying its message. Any other error throws.
  - hibernated: `submitTurn` resumes it itself (`ensureResumed`).
- `submitTurn(id, { kind: "event", text, typedText })`. The ledger wraps it in `<equin-event>`, so the worker's transcript draws it as a system card (event-turn renderer), not as a user bubble. Rewind cannot cut there. Body:

  ```
  Message from the agent on task-… "Title" (conv-…):

  <text>
  ```

- Result: "Sent to conv-… (working: it reads it at its next step | idle: it starts now | resumed: delivered once it is up)". The replies come back the way the worker already talks back (its reports and flags, as watch events). The tool description says so. It names no capability.

## 4. Capability describe

> You may see the agents in this tree with `list_agents` and message one with `message_agent`: a reply to a report, a correction, "push it". A message reaches it at once (mid-turn, at its next step) and resumes it if it stopped; its answer comes back through its own reports and flags.

## Known trade-offs (from "inject now")

- A message typed while the target has a pending `compact_context` makes it busy. `self-compact.send` then waits for the next idle moment. It is not lost, but it is no longer first in line.
- A message withdraws a held AskUserQuestion the user had not answered yet, the same way a user's own non-answer turn does.

## Verification

- `./equin test plugins/tasks/plugins/orchestration/plugins/message`: `treeAgents` on a worktree-DB scenario covers:
  - latest conversation per task;
  - whole tree from the mandate root;
  - `self` marked;
  - no mandate gives "no tree".

  Scope refusals: outside the tree, self, no conversation. The send outcome per status uses fake ports (resume called only for gone/done; a blocked resume becomes a tool error).
- `./equin build`: checks (boundaries, cycles, plugins-doc-in-sync). There is no migration, since no table is added.
- On the build:
  - Debug → MCP tools lists `list_agents` / `message_agent` for a supervisor-mandate conversation only.
  - `query_db` shows the event turn row after a send.

  Live delivery into a real worker is the Dogfood check, as for watch events.
