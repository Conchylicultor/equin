# Unattached MCP sessions (recovery from a terminal)

## Context

A `claude` started in a terminal — the usual way to recover a broken main — gets
no equin MCP tools. `.mcp.json` builds the server URL as
`${EQUIN_PARENT_URL}/api/mcp/${EQUIN_CONVERSATION_ID}`, and only a session equin
launched carries those variables (`conversations/agent-launch`'s
`agent-session-env.ts`). Unset, Claude Code cannot expand the URL and never
connects. Setting them by hand (as `sidequests/claude-web/session-picker.sh`
does, with an invented id) is not enough either: every tool that resolves "my
worktree" throws `Unknown conversation`, and the browser tools all fail.

Goal: a session equin did not launch reaches the read-only, conversation-free
tools, aimed at main. Out of scope (parked on the Parking page): a setup
command that makes a terminal session a real equin conversation (task,
worktree, mandate, system-prompt sections).

Decided with the user: page writes and task filing (`add_task`,
`propose_task`, `edit_page`, `write_agent_note`) stay unavailable unattached.

## Design

### The unattached caller (infra/mcp)

- `MCP_UNATTACHED_ID = "unattached"` (core): the reserved path segment of
  `POST /api/mcp/:conversationId` for a session with no conversation. It cannot
  collide with a conversation id (`conv-…` / legacy `claude-…`). One route, no
  second endpoint.
- A tool opts in with `unattached: true`. Its handler's context is
  `McpCallerContext = { conversationId: string | null; toolUseId }`, `null`
  meaning unattached — so tsc makes every opted-in handler handle "no
  conversation". A tool that does not opt in keeps `conversationId: string`.
  `McpTool` is a union discriminated on `unattached`; an unattached tool may not
  declare `when`, `liveDescription` or `profiles` (`?: never`) — each of those
  is a function of a conversation.
- Request path (`machine/internal/handle-mcp.ts`): for the unattached id, skip
  the scope resolver and the live descriptions, and mount only the opted-in
  tools. `mountTool` asserts a conversation-only tool is never mounted for an
  unattached caller (loud runtime failure, the request path cannot reach it).
- Catalog: `McpCatalogTool.unattached: boolean`, so Debug → MCP tools shows it.

### `.mcp.json`

```json
"url": "${EQUIN_PARENT_URL:-http://equin.localhost:9000}/api/mcp/${EQUIN_CONVERSATION_ID:-unattached}"
```

Claude Code expands `${VAR:-default}` in `.mcp.json`. The gateway already reads
a request with no `Sec-Fetch-Site` and no `Origin` as the owner (a local tool),
so a terminal session is authorised exactly like an in-app agent.

New check `mcp:mcp-json-in-sync` (rung 3 — the file is JSON, it cannot import
the constants): the `equin` server's URL must be exactly the string above,
built from `namespaceUrl(MAIN_WORKTREE_NAME)` and `MCP_UNATTACHED_ID`.

### Tools that opt in (default target: main)

| Tool | Unattached behaviour |
|---|---|
| `get_timeline` | unchanged (uses no conversation) |
| `query_db` | no `database` → main's DB (`MAIN_WORKTREE_NAME`) |
| `get_queue_health`, `get_runtime_profile`, `benchmark_boot` | no `worktree` → main |
| `read_page` | instructions covering the page are shown on every read (nothing records them as received: there is no conversation to record against) |
| `browser_*` | target = main's deploy; one shared browser session keyed `unattached` (closes on idle like any other); calls are not recorded (a recording files under a transcript's tool call, and there is no transcript) |

Everything else stays conversation-only and is simply absent from an
unattached session's `tools/list`.

## Files

- `plugins/infra/plugins/mcp/{core,server,machine}` — constant, types, request
  path, catalog, CLAUDE.md, tests (`machine/internal/handle-mcp.test.ts`).
- `plugins/infra/plugins/mcp/check/index.ts` — the `.mcp.json` check.
- `.mcp.json`.
- Opt-ins: `database/query`, `debug/timeline`, `debug/queue-health`,
  `debug/profiling/{runtime,boot-bench}`, `page/annotations/agent-access`
  (+ `deliverWithRead` accepting `null`), `infra/mcp/browser`
  (`target.ts`, `tools.ts`).
- `debug/mcp-tools` web: show the `unattached` flag beside `gated`.

## Verification

- `./equin test plugins/infra/plugins/mcp` — new cases: unattached request lists
  only opted-in tools, calls one with `conversationId: null`, never runs a
  `when` or the scope resolver.
- `./equin check` (type-check, the new check, boundaries).
- `./equin build`, then from a shell with the equin variables unset:
  `curl` an `initialize` + `tools/list` to
  `http://<this worktree>.localhost:9000/api/mcp/unattached` and call
  `query_db` / `get_timeline`.
