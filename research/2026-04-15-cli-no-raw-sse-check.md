# Enforce all SSE through the multiplex (`no-raw-sse` check)

## Context

The unified multiplex (see `2026-04-14-global-unified-sse-multiplex.md`) routes every SSE stream through the core `/api/events?urls=…` endpoint. Plugins declare streams via `sseRoutes` on their `ServerPluginDefinition`; they never write `text/event-stream` themselves.

After rebasing onto main, `plugins/tasks/server/index.ts` brought back `"GET /api/tasks/stream": handleStream` as a raw `httpRoutes` entry that returns a `text/event-stream` body from `plugins/tasks/server/internal/sse.ts`. It completely bypasses the multiplex: extra TCP connection, its own heartbeat logic, no shared leader election. Nothing currently prevents a new plugin (or a rebase) from reintroducing the same anti-pattern.

The existing `no-raw-event-source` check covers the **client** side (forces consumers through `ReconnectingEventSource`). We need the **server-side** equivalent.

## Design

Add a new check `no-raw-sse` in `cli/src/checks/no-raw-sse.ts`, registered in `cli/src/checks/index.ts`. It runs as part of `./equin check` and (by extension) `./equin push`.

### What it flags

`git grep` for the SSE content-type literal across TS/TSX:

```
git grep -nE 'text/event-stream' -- '*.ts' '*.tsx'
```

Any hit outside the allow-list is a violation. Allow-list:

- `server/src/index.ts` — the one legitimate writer (core `/api/events` handler).
- `cli/src/checks/no-raw-sse.ts` — self-match (the literal lives in the check's own source).
- `research/` — docs.

This catches the real smell ("I'm shipping my own SSE response") regardless of URL naming. `GET /api/tasks/stream` today would be flagged because `plugins/tasks/server/internal/sse.ts:*` sets `"content-type": "text/event-stream"`. Renaming the path wouldn't get around it.

### Why content-type, not path

Alternatives considered:

- **Grep for `httpRoutes` keys ending in `/stream`** — brittle, path-convention-driven, trivially bypassed by renaming.
- **AST-parse plugin definitions and forbid SSE-shaped handlers** — far more code than warranted; same signal as grepping the header.
- **Grep for `ReadableStream` in handler files** — too broad; `ReadableStream` has legitimate non-SSE uses.

`text/event-stream` is the defining wire-level marker of SSE. If a handler sets it, it's bypassing the multiplex. If it doesn't, it isn't SSE.

### Gateway caveat

`gateway/proxy.go:215` also sets `text/event-stream` (Go, proxying logs). The check is TS-only (`*.ts`/`*.tsx` globs), so the gateway isn't touched. Called out here so it isn't later "fixed" to scan Go.

### Error message

```
raw `text/event-stream` response found in <n> place(s):
    plugins/tasks/server/internal/sse.ts:42:...

Hint: Declare the stream in `sseRoutes` on the plugin's `ServerPluginDefinition`
and emit via `send(...)` inside `subscribe()`. The core multiplex at
`server/src/index.ts` owns response encoding and heartbeat. See
`server/CLAUDE.md` → "SseHandler Interface".
```

## Critical files

- `cli/src/checks/no-raw-sse.ts` — new check; mirror structure of `cli/src/checks/no-raw-event-source.ts`.
- `cli/src/checks/index.ts` — register in `CHECKS`.
- `plugins/tasks/server/index.ts` + `plugins/tasks/server/internal/sse.ts` — migrate to `sseRoutes`. Without this, the new check immediately fails on main after it lands. Conversion mirrors what was done for `conversations/server/internal/sse.ts` in the original multiplex rollout.

## Verification

1. Run `./equin check --list` → `no-raw-sse` appears.
2. Run `./equin check --no-raw-sse` against the branch **before** migrating tasks → fails, pointing at `plugins/tasks/server/internal/sse.ts`.
3. Migrate tasks to `sseRoutes` → check passes.
4. `./equin build` → tasks list still streams updates in the UI (single `/api/events` connection in DevTools → Network, with `event: /api/tasks/stream` frames).
5. Re-add a raw `text/event-stream` response anywhere in a TS file → `./equin check` fails. Remove it → passes.
