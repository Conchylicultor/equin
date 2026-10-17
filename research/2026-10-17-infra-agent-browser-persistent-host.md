# Agent browser: a host that outlives the backend

**Status:** implemented · **Date:** 2026-10-17 · Track: Mental model › Harness › Browsing
Builds on `research/2026-10-17-infra-agent-browser-mcp.md` (v1).

## Context

v1 keeps Chromium, every `BrowserContext` and every tab's console/network log in the
memory of the backend that serves MCP — main, in practice. Main restarts on every push
(auto-build), so every agent's open tabs vanish mid-investigation several times an hour.
(e2e *scripts* are unaffected: each launches its own Chromium in the script process.)

Three more gaps from the v1 review, done here too:

1. Nothing shows whether the browser runs, who holds sessions, or when they expire.
2. Closing a session reverts **every** agent write on the target (`POST
   /api/agent-writes/revert` has no filter), so one conversation's close undoes another
   conversation's — or an e2e run's — writes. The e2e harness has the mirror bug.
3. Only `done` closes a session; a conversation that dies (`gone`) holds it 10 minutes.

## Why not just detach Chromium

Playwright creates every context with `disposeOnDetach: true` (playwright-core 1.62,
`coreBundle.js`), and a Playwright server closes a client's contexts when it disconnects.
So a surviving Chromium still loses every tab the moment the backend's connection drops.
**The process that holds the Playwright objects must be the one that survives.** That
is the embedded-Postgres shape (detached process, pidfile + socket, reattach), not the
supervised-job shape backups use (run-to-completion).

## Design

### The host process — `bin/host.ts`

One detached bun process per machine (the wiki's "shared across all worktrees/agents"),
owning Chromium, sessions, tabs, logs and the idle deadlines — today's `host.ts` moved
whole, plus a tiny HTTP server on a Unix socket:

- `POST /call {conversationId, target, tool, args}` → the tool's `McpToolResult`.
- `POST /close {conversationId}` → `{closed}` (context closed + scoped revert).
- `POST /shutdown {reason}` → closes every session (reverting each), then exits.

Files, in one `defineDataDir({ kind: "services", name: "agent-browser", reclaim: restart })`:
`host.sock`, `host.pid`, `host.lock`, `status.json`.

- **Singleton:** on start the host `flockTry`s `host.lock`; losing means another host owns
  the machine → exit 0. The kernel drops the lock on any death.
- **Lifetime:** sessions close after 30 idle min / `browser_close` / conversation end;
  the host exits 5 min after its last session (closing Chromium with it). Deadlines are
  timers in the host — they now survive backend restarts too.
- **Published state:** `status.json`, rewritten atomically (tmp + rename) on every
  change — `{ protocol, codeId, pid, startedAt, state: "ready" | "exited", exitReason?,
  idleExitAt, sessions: [{ conversationId, origin, openedAt, idleDeadline, tabs: [{ id,
  url, title }] }], errors }`. A clean exit leaves `state: "exited"` behind, so a dead
  pid with a `ready` status reads as "host died".

### The backend side — `server/`

- **Tools** keep their declarations (name, description, input schema) in
  `shared/tools.ts`, imported by both halves: the backend registers `Mcp.tool`s whose
  handler resolves the target (needs the DB, so it stays here) and forwards to `/call`;
  the host dispatches the same table to the implementations in `bin/`. One table, so the
  two halves cannot list different tools.
- **`ensureHost()`**: read `status.json`; if its pid is alive and `codeId` matches → use
  it. Otherwise check Chromium is installed (`readyNow` / `requestDep`, the existing "not
  installed yet" answer), and launch `process.execPath bin/host.ts` through a
  `defineDaemon({ where: "host-singleton", restart: never }).launchDetached` (pidfile =
  `host.pid`), so it is listed in Background activity. Readiness is pushed: a
  `defineFileWatcher` on the data dir resolves the waiter when `status.json` reports
  `ready` (30 s bound). A backend that boots with a host already running `attach`es it.
- **Code identity:** `codeId` = sha256 of this plugin's `bin/` + `shared/` sources. A host
  running other code is asked to `/shutdown` (reason `upgrade`) and replaced — so a push
  that does not touch the browser leaves every session intact.
- **Release builds:** the host is a source entry; a compiled release has no bun to run it.
  `ensureHost` refuses loudly there (same constraint as `debug/paging-probe`).

### Health row — `web/` + `core/`

`core`: `liveValue("agent-browser.status")`. Server: `serveValue(…, { source: "external",
changes: "notified" })`, loader = `status.json` + pid liveness, notified by the same file
watcher (push, no polling). Web: `HealthReport.Row({ kind: "status", id:
"agent-browser" })`:

- ok — "Not running — starts on the first browser_* call" / "N sessions, M tabs".
- attention — the status names a pid that is dead without a clean exit ("host died").
- detail — sessions as a DataView (conversation, target, tabs, idle deadline) + host pid
  and its idle-exit time.

### Scoped revert — `request-origin/agent-write-ledger`

`POST /api/agent-writes/revert` gains a **required** body: `{ scope: "source", source }`
or `{ scope: "prefix", prefix }`. Revert-everything becomes inexpressible.

- Agent-browser sessions stamp `source = mcp-browser:<conversationId>` and revert exactly it.
- The e2e harness reverts `prefix: "e2e:"` (its sources are `e2e:<script>`), so it no
  longer reverts a live agent session's writes. Concurrent e2e runs still share (known limit).
- One entry per key keeps the FIRST writer's source; a key two sources wrote is reverted
  by the first one's close (documented).

### Conversation end

The trigger job closes the session when the status becomes `done` **or** `gone` (the only
two non-running states; `gone` can resume, and a resumed conversation simply opens a new
session). If no host is running, the backend still reverts the conversation's source
directly on its target — a host that crashed leaves its writes in the on-disk ledger, and
this is what reclaims them.

## Files

- `plugins/infra/plugins/mcp/plugins/browser/`: `bin/host.ts` (+ `bin/internal/*`: session,
  tool implementations, status writer, server), `shared/tools.ts`, `shared/protocol.ts`,
  `data-dirs/index.ts`, `core/` (status live value), `server/internal/{host-client,
  tools, conversation-ended, status}.ts`, `web/` (row + detail). Delete `server/internal/host.ts`.
- `plugins/infra/plugins/request-origin/plugins/agent-write-ledger/{core,server}`: request
  body + filtered revert.
- `plugins/framework/plugins/tooling/plugins/e2e-harness/e2e/agent-writes.ts`: send the prefix.

## Verification

1. `./singularity build`; `browser_navigate /agents` + `browser_read_page`.
2. Restart this worktree's backend (`./singularity build` again); `browser_tabs` still lists
   t1 with its URL, and `browser_console` still holds the earlier messages.
3. Health report shows the Agent browser row with the session and its deadline.
4. Scoped revert: unit test in the ledger (two sources, revert one).
5. `browser_close` → session gone from the row; host exits 5 min later (row → not running).
