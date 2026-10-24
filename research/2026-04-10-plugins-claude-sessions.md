# Claude Sessions Plugin

## Context

The `sidequests/claude-web/` project runs Claude Code in the browser via ttyd + tmux. It works well but lives outside the Singularity app. This plugin brings the same functionality into the app: a sidebar listing Claude tmux sessions, a button to create new ones, and terminal panes that attach to them.

The key insight from claude-web: tmux sits between the browser and Claude. When the tab closes, tmux detaches but Claude keeps running. Reconnecting is just `tmux attach`.

## Approach: Extend Terminal Plugin + New Plugin

Two pieces:
1. **Extend the terminal plugin** with a `command` option so it can run `tmux attach` instead of a raw shell
2. **New `claude-sessions` plugin** with server API (tmux/worktree management) and sidebar UI

## Step 1: Terminal Plugin — Add `command` Support

Small, backwards-compatible change. Existing callers unaffected.

### `plugins/terminal/shared/protocol.ts`

Add `command?: string[]` to `SessionCreateMsg`:

```ts
export type SessionCreateMsg = {
  type: "session.create";
  cols: number;
  rows: number;
  cwd?: string;
  command?: string[];  // if set, spawn this instead of default shell
};
```

### `plugins/terminal/server/internal/pty-manager.ts`

Add `command?: string[]` to `CreateSessionOptions`. Change spawn logic:

```ts
const cmd = options.command?.[0] ?? (process.env.SHELL || "bash");
const args = options.command?.slice(1) ?? [];
const p = spawn(cmd, args, { ... });
```

### `plugins/terminal/server/internal/ws-handler.ts`

Pass `parsed.command` through to `createSession()`.

### `plugins/terminal/web/components/terminal.tsx`

Accept `command` prop, include in `session.create` message:

```ts
export function TerminalView({ command }: { command?: string[] }) {
  // ... in ws open handler:
  const msg: ClientMessage = {
    type: "session.create",
    cols: term.cols,
    rows: term.rows,
    ...(command && { command }),
  };
```

### `plugins/terminal/web/views.tsx`

```ts
export function terminalPane(opts?: { command?: string[]; title?: string }): PaneDescriptor {
  const Component = () => <TerminalView command={opts?.command} />;
  return { title: opts?.title ?? "Terminal", component: Component };
}
```

## Step 2: claude-sessions Server Plugin

### File structure

```
plugins/claude-sessions/
  package.json
  shared/
    types.ts
  server/
    index.ts
    internal/
      tmux.ts
      handle-list.ts
      handle-create.ts
      handle-delete.ts
```

### `shared/types.ts` — API contract

```ts
export interface ClaudeSession {
  name: string;
  created: string;       // human-readable from tmux
  paneTitle: string;     // Claude sets this to current task
  attached: boolean;
}
```

### `server/internal/tmux.ts` — tmux helpers

Three functions, all use `Bun.spawn()`:

- **`listClaudeSessions()`** — runs `tmux list-sessions -F "#{session_name}|#{t:session_created}|#{pane_title}|#{session_attached}" -f "#{m:claude-*,#{session_name}}"`. Parses pipe-delimited output. Returns `[]` if tmux server not running.

- **`createClaudeSession()`** — generates `claude-<epoch>` name, creates git worktree (`git worktree add -b claude-web/<name> <wt_path> main`), starts tmux (`tmux new-session -d -s <name> -c <wt_path> "zsh -l -c 'claude'"`). Returns session info.

- **`deleteClaudeSession(name)`** — runs `tmux kill-session -t <name>`. Worktree cleanup deferred (may have uncommitted work).

Path detection: use `git rev-parse --show-toplevel` to find repo root. Worktree dir = `<root>/.claude/worktrees`.

### `server/index.ts` — route registration

```ts
httpRoutes: {
  "GET /api/claude-sessions": handleList,
  "POST /api/claude-sessions": handleCreate,
  "DELETE /api/claude-sessions": handleDelete,  // ?name=claude-xxx
}
```

Register in `server/src/plugins.ts`.

## Step 3: claude-sessions Frontend Plugin

### `web/components/session-list.tsx` — sidebar panel

- Fetches sessions from `GET /api/claude-sessions` on mount + after mutations
- Manual refresh button (no polling — sessions don't change frequently)
- "New Session" button at top: POST, refresh, open terminal pane
- Each session item: click opens `Shell.OpenPane(terminalPane({ command: ["tmux", "-u", "attach", "-t", name], title: name }))`
- Delete button per session (icon, visible on hover)
- Uses `SidebarMenu`/`SidebarMenuItem`/`SidebarMenuButton` from shadcn

### `web/index.ts` — plugin definition

```ts
contributions: [
  Shell.Sidebar({
    title: "Claude Sessions",
    icon: MdSmartToy,
    component: SessionList,
  }),
]
```

Register in `web/src/plugins.ts`.

## Key Design Decisions

**tmux attach in a PTY is the right abstraction.** When the browser tab closes, the terminal plugin kills the PTY (which runs `tmux attach`). Killing `tmux attach` just detaches — it does NOT kill the tmux session. Claude continues running. This is exactly the claude-web behavior, no special handling needed.

**No polling.** Fetch on mount + refetch after create/delete + manual refresh button. Simple and sufficient.

**Worktree cleanup deferred.** Deleting a session kills tmux but leaves the worktree. Worktrees may have uncommitted changes. Add cleanup as a follow-up.

**Session name validation.** Only allow `claude-*` pattern with alphanumeric + hyphens to prevent injection into tmux commands.

## Implementation Order

1. Terminal plugin `command` extension (prerequisite, can be tested independently)
2. `shared/types.ts`
3. Server plugin (tmux helpers, then handlers, then registration)
4. Frontend plugin (sidebar component, then registration)

## Verification

1. After Step 1: Open a terminal pane, verify default shell still works. Manually test with a command array.
2. After Step 3: `curl localhost:<port>/api/claude-sessions` — should return existing `claude-*` sessions. `curl -X POST` should create one.
3. After Step 4: Open app, see "Claude Sessions" in sidebar. Click "New Session", verify terminal opens with Claude. Close tab, reopen, verify session still listed and can be reattached.
4. Run `./equin build` to deploy.

## Files to Modify

- `plugins/terminal/shared/protocol.ts` — add `command` field
- `plugins/terminal/server/internal/pty-manager.ts` — accept `command` option
- `plugins/terminal/server/internal/ws-handler.ts` — pass `command` through
- `plugins/terminal/web/components/terminal.tsx` — accept `command` prop
- `plugins/terminal/web/views.tsx` — extend factory signature
- `server/src/plugins.ts` — register server plugin
- `web/src/plugins.ts` — register frontend plugin

## Files to Create

- `plugins/claude-sessions/package.json`
- `plugins/claude-sessions/shared/types.ts`
- `plugins/claude-sessions/server/index.ts`
- `plugins/claude-sessions/server/internal/tmux.ts`
- `plugins/claude-sessions/server/internal/handle-list.ts`
- `plugins/claude-sessions/server/internal/handle-create.ts`
- `plugins/claude-sessions/server/internal/handle-delete.ts`
- `plugins/claude-sessions/web/index.ts`
- `plugins/claude-sessions/web/components/session-list.tsx`
