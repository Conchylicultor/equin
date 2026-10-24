# MCP `add_task` Tool + Task Author Field

## Context

Today, agents running inside equin-spawned conversations have no programmatic way to create child tasks under their own task. They can edit code, but task-tree changes have to go through the human user (via the UI). We want agents to decompose work themselves: a Claude session working on "implement X" should be able to spawn child tasks like "write tests for X" or "document X" and have them appear under its own node in the task tree.

The mechanism: a per-conversation HTTP MCP server endpoint hosted on the **parent** backend (the one that spawned the conversation), exposing an `add_task(title, description?)` tool. The conversation's `spawnedBy` field already records which backend owns its data; we use that to construct the MCP URL.

We also add an `author` column to `_tasks` so the UI can later distinguish user-created tasks from agent-created ones (and from which agent).

## Design

### Plugin vs core

**Keep MCP as a plugin.** CLAUDE.md is explicit: "Every feature is a plugin. The core app is thin plumbing." The pattern to mirror is `Runtime.register` in `plugins/conversations/server/api.ts` — a registration API exposed by a plugin, with other plugins (`runtime-tmux`, `runtime-api`) plugging in. MCP fits the same shape: one plugin owns the HTTP route + tool registry; other plugins contribute tools by importing from `@plugins/infra/plugins/mcp/server/api`.

The cross-plugin dependency direction (`tasks` → `mcp`) is fine — `conversations` already imports from `tasks`, etc. The plugin graph is a directed graph, not a tree.

### 1. New plugin: `plugins/mcp/server/` (infra only — no tools)

```
plugins/mcp/
├── package.json              # adds @modelcontextprotocol/sdk
└── server/
    ├── index.ts              # ServerPluginDefinition
    ├── api.ts                # public: Mcp.registerTool, McpTool, McpToolContext
    └── internal/
        ├── registry.ts       # module-level Map<name, McpTool>
        └── handle-mcp.ts     # POST /api/mcp/:conversationId
```

The mcp plugin **defines no tools itself**. It only provides:
- The HTTP endpoint
- The `Mcp.registerTool(tool)` registration API

`handle-mcp.ts` instantiates an `McpServer` from `@modelcontextprotocol/sdk` per request, walks the registry to register every tool against it (each handler wrapped to inject the per-request `McpToolContext` carrying `conversationId`), and dispatches via `StreamableHTTPServerTransport` in **stateless mode** — no session id, each call is a fresh transport. This matches Bun's request/response model and avoids SSE plumbing.

### 2. Public API: `plugins/mcp/server/api.ts`

```typescript
import { z } from "zod";

export interface McpToolContext {
  conversationId: string;
}

export interface McpTool<TInput extends z.ZodRawShape = z.ZodRawShape> {
  name: string;
  description: string;
  inputSchema: TInput;
  handler: (
    args: z.objectOutputType<TInput, z.ZodTypeAny>,
    ctx: McpToolContext,
  ) => Promise<{ content: Array<{ type: "text"; text: string }> }>;
}

export const Mcp = {
  registerTool<T extends z.ZodRawShape>(tool: McpTool<T>): void {
    registry.set(tool.name, tool as McpTool);
  },
};
```

Registration happens at module-load time. Plugins import a side-effect module (e.g. `import "./internal/mcp-tools"` from their own `index.ts`) so registration runs whenever the plugin loads. No load-order constraint — the registry is a plain module-level Map populated synchronously on import; the HTTP handler reads it at request time.

### 3. `add_task` lives in the **tasks** plugin

```
plugins/tasks/server/
└── internal/
    └── mcp-tools.ts          # NEW — registers add_task
```

```typescript
// plugins/tasks/server/internal/mcp-tools.ts
import { z } from "zod";
import { eq } from "drizzle-orm";
import { Mcp } from "@plugins/infra/plugins/mcp/server/api";
import { db } from "../../../../server/src/db/client";
import { _tasks } from "../schema_internal";
import { conversations } from "@plugins/conversations/server/schema";
import { tasksResource } from "./resources";

Mcp.registerTool({
  name: "add_task",
  description: "Add a child task under the current conversation's task",
  inputSchema: { title: z.string(), description: z.string().optional() },
  async handler({ title, description }, { conversationId }) {
    const [conv] = await db.select({ taskId: conversations.taskId })
      .from(conversations).where(eq(conversations.id, conversationId)).limit(1);
    if (!conv) throw new Error(`Unknown conversation ${conversationId}`);

    const id = `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    await db.insert(_tasks).values({
      id, parentId: conv.taskId, title, description, author: conversationId,
    });
    tasksResource.notify();
    return { content: [{ type: "text", text: `Created task ${id}` }] };
  },
});
```

Pulled in by `plugins/tasks/server/index.ts` via a side-effect import: `import "./internal/mcp-tools";`. Add `@plugins/mcp` to `plugins/tasks/package.json` dependencies (workspace).

### 4. `author` column on `_tasks`

Add `author: text("author")` (nullable) to `plugins/tasks/server/schema_internal.ts`.

Migration name: `add_task_author`. Backfills existing rows to `'user'`. Generated by `./equin build --migration-name add_task_author`.

Author values:
- `"user"` — created via the UI (default in `handle-create.ts` when not specified)
- `<conversationId>` — created by an agent via MCP
- `spawnedBy ?? "user"` — for tasks synthesised in `lifecycle.ts:64-75` (the auto-created task for a fresh conversation)

Update sites:
- `plugins/tasks/server/internal/handle-create.ts` — default `author = body.author ?? "user"`
- `plugins/conversations/server/internal/lifecycle.ts:67-74` — pass `author: opts.spawnedBy ?? "user"` on the synthesised task

### 5. MCP config file: `.mcp.json` at repo root (committed)

Use Claude Code's standard auto-discovery path. Single tracked file. Same content for every backend and every conversation — the URL is parameterised via env vars Claude Code expands at config-load time.

```json
{
  "mcpServers": {
    "singularity": {
      "type": "http",
      "url": "http://${SINGULARITY_PARENT_HOST}.localhost:9000/api/mcp/${SINGULARITY_CONVERSATION_ID}"
    }
  }
}
```

Why `.mcp.json` (not `--mcp-config <other>`):
- Auto-discovered by Claude Code at the project root — no flag needed in `tmux-runtime`.
- Same trust-prompt behaviour as `--mcp-config`, so the flag buys nothing.
- Reviewable in PRs.
- Git worktrees share the same checked-in files, so every spawned worktree already has it.

The two env vars (`SINGULARITY_PARENT_HOST`, `SINGULARITY_CONVERSATION_ID`) are exported per-conversation when tmux spawns Claude (see §6).

### 6. Spawn changes

**`plugins/conversations/server/internal/lifecycle.ts`**: pass `spawnedBy` through to `runtime.create()` instead of letting the runtime re-read env. Currently `spawnedBy` is computed at line 124 and lost.

```typescript
await runtime.create(conversationId, worktreePath, {
  prompt: opts.prompt, model, spawnedBy,
});
```

**`plugins/conversations/server/api.ts`**: add `spawnedBy?: string | null` to the `ConversationRuntime.create` opts type.

**`plugins/conversations/plugins/runtime-tmux/server/internal/tmux-runtime.ts:96-128`**: extend the shell command to export the env vars. Claude auto-discovers `.mcp.json` from the cwd (the worktree), so no flag change needed:

```typescript
const parentHost = opts?.spawnedBy ?? "singularity";
// claudeBase unchanged from current code
// shell command becomes:
`zsh -l -c 'export SINGULARITY_CONVERSATION_ID=${conversationId}; export SINGULARITY_PARENT_HOST=${parentHost}; ${claudeCmd}'`
```

### 7. Pre-approve MCP trust via `.claude/settings.json`

Claude Code supports `enableAllProjectMcpServers: true` in project-scoped `.claude/settings.json`. Setting this once (committed to the repo) auto-approves every `.mcp.json` server for the project — no per-path entries in `~/.claude.json`, no runtime mutation of user-home files, no first-run trust prompt in spawned worktrees (they share the checkout).

Edit `.claude/settings.json` to add:

```json
{
  "enableAllProjectMcpServers": true
}
```

(Merge with any existing keys rather than overwriting.)

### 8. Backfill migration for `spawnedBy`

Existing `_conversations` rows have `spawnedBy IS NULL`. Add a one-line backfill in the `add_task_author` migration (or a separate one):

```sql
UPDATE conversations SET spawned_by = 'singularity' WHERE spawned_by IS NULL;
```

Without this, legacy conversations would compute `parentHost = "singularity"` via the runtime fallback — same end result, but explicit DB state is cleaner.

## Caveats / known limits

- **No auth on the MCP endpoint.** Anyone reachable on `<host>.localhost:9000` can call `add_task` on any conversation id. Trust model is single-user laptop. If we ever multi-user, add a per-conversation HMAC token in the URL path (`/api/mcp/:id/:token`, computed from a server-side secret + conversationId — no storage).
- **Tasks created via `add_task` only appear in the parent backend's UI.** The child conversation's own forked DB is unrelated. Users reviewing the child worktree at `<id>.localhost:9000` won't see the new task; they need to view the parent (typically `equin.localhost:9000`).
- **DNS for `<slug>.localhost` from Claude's process must resolve.** macOS resolves `*.localhost → 127.0.0.1` by default; this should work but is the one thing to verify end-to-end before considering the feature done.
- **Trust pre-approval is project-scoped.** The `enableAllProjectMcpServers: true` flag in `.claude/settings.json` auto-approves *every* `.mcp.json` server for this project, not just `singularity`. If we later add a second, untrusted MCP server to `.mcp.json`, it gets auto-approved too — switch to the allowlist variant `enabledMcpjsonServers: ["singularity"]` if that becomes a concern.

## Critical files to modify

**New (mcp infra plugin — no tools):**
- `plugins/mcp/package.json` — depends on `@modelcontextprotocol/sdk`, `zod`
- `plugins/mcp/server/index.ts` — `ServerPluginDefinition` with route
- `plugins/mcp/server/api.ts` — `Mcp.registerTool`, `McpTool`, `McpToolContext`
- `plugins/mcp/server/internal/registry.ts` — module-level `Map<string, McpTool>`
- `plugins/mcp/server/internal/handle-mcp.ts` — per-request `McpServer` + tool wiring

**New (tasks plugin's tool registration):**
- `plugins/tasks/server/internal/mcp-tools.ts` — registers `add_task` via `Mcp.registerTool`

**New (repo root):**
- `.mcp.json` — committed; defines the `singularity` MCP server with env-var URL interpolation. Auto-discovered by Claude Code in every worktree.

**Modified:**
- `server/src/plugins.ts` — register `mcpPlugin`
- `plugins/tasks/server/index.ts` — `import "./internal/mcp-tools";` (side effect)
- `plugins/tasks/package.json` — add `@plugins/mcp` workspace dep
- `plugins/tasks/server/schema_internal.ts` — add `author` column
- `plugins/tasks/server/internal/handle-create.ts` — default author to `"user"`
- `plugins/conversations/server/internal/lifecycle.ts:67-74` and `:136-139` — set author on synthesised task; pass `spawnedBy` to `runtime.create`
- `.claude/settings.json` — add `enableAllProjectMcpServers: true` (§7)
- `plugins/conversations/server/api.ts` — extend `ConversationRuntime.create` opts type
- `plugins/conversations/plugins/runtime-tmux/server/internal/tmux-runtime.ts:96-128` — export `SINGULARITY_CONVERSATION_ID` + `SINGULARITY_PARENT_HOST` in the shell command (Claude auto-discovers `.mcp.json` from cwd, no flag)
- `docs/plugins.md` — add `mcp` plugin entry

## Verification

1. `./equin build --migration-name add_task_author` — generates migration; restart applies it. Confirm `tasks.author` column exists and existing rows backfilled to `"user"`.
2. `./equin build` (subsequent, no schema change) — confirm new `mcp` plugin loads; confirm `.mcp.json` is present at the repo root (and inside every spawned worktree, since worktrees share the checkout).
3. Spawn a fresh conversation from the UI. Inspect the resulting tmux session: `tmux show-environment -t <conversationId>` should include `SINGULARITY_CONVERSATION_ID` and `SINGULARITY_PARENT_HOST`.
4. Inside the spawned Claude session, run `/mcp` and confirm `singularity` shows as connected with **no trust prompt** (verifying §7 worked).
5. Have the spawned Claude call the `add_task` tool with a sample title. Verify:
   - The task appears in the parent backend's task tree (live, via WS push)
   - DB row has `parent_id = <spawning conversation's task id>` and `author = <conversationId>`
6. Create a task from the UI; confirm `author = "user"` in the DB row.
7. Spawn a second-level conversation (a child of a child). Confirm its synthesised task gets `author = <parent conversationId>` and the MCP URL still resolves to the correct parent backend.
8. End-to-end smoke: open `http://equin.localhost:9000` → spawn agent on a trivial task → ask the agent to "create a child task called 'hello' via the add_task tool" → see it appear in the tree under the agent's node, attributed to the agent's conversation id.
