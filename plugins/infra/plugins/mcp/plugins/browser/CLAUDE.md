# browser

The agent browser: `browser_*` MCP tools that drive one shared headless
Chromium. Interactive like Claude-in-Chrome (tabs stay open between calls, so an
agent retries one step instead of replaying a script), isolated like the e2e
harness (a `BrowserContext` per conversation, targeted at that conversation's
own worktree build). Design: `research/2026-10-17-infra-agent-browser-mcp.md`,
then `research/2026-10-17-infra-agent-browser-persistent-host.md` (the host
process); wiki track: Mental model › Harness › Browsing.

## The host process owns everything

Chromium, every context, every tab and its console / network record live in
ONE detached process per machine, `bin/host.ts` — not in a backend. Playwright
creates each context with `disposeOnDetach`, so whoever holds the Playwright
connection owns the tabs: in a backend, main's restart on every push closed
every agent's tabs. The host outlives any backend.

- **Backend side** (`server/internal/host-client.ts`): `ensureHost()` reads the
  host's `status.json`; a running host with this checkout's `codeId` (a hash of
  `bin/` + `shared/` + `core/`) and `HOST_PROTOCOL` is used as is. None → check
  Chromium is installed (`readyNow` / `requestDep`, "not installed yet" is an
  answer), then `defineDaemon(...).launchDetached` `bun bin/host.ts` and wait
  for `ready` on the status file (a file watcher, no polling). Other code →
  **main** sends `/shutdown {reason: "upgrade"}` and relaunches (sessions
  close); a worktree backend uses a host of the same protocol rather than fight
  main. So a push that does not touch this plugin keeps every session.
- **Wire** (`shared/protocol.ts`): HTTP on `host.sock` — `POST /call`
  (`{conversationId, target, tool, args}` → the MCP result; 422 = the tool's
  own failure), `/close`, `/shutdown`. Bump `HOST_PROTOCOL` on any change.
- **One tool table** (`shared/tools.ts`): the backend registers each spec as an
  `Mcp.tool` that resolves the target (a DB read — the host has no DB) and
  forwards; the host implements a record over the same keys
  (`bin/host-tools.ts`), so a tool cannot exist on one side only.
- **Singleton**: the host `flockTry`s `host.lock` at start; the loser exits 0.
- **Not in a release**: the host runs from source; `ensureHost` refuses in a
  compiled release.

Files: `services/agent-browser/` (`data-dirs`) — `host.sock`, `host.pid`,
`host.lock`, `status.json`.

## Model

- **Host** — exits 5 min after its last session closes (Chromium with it), on
  `/shutdown`, or on SIGTERM/INT/HUP; each exit closes every session first and
  writes a final `exited` status.
- **Session** — one `BrowserContext` per conversation. Closed after 30 idle
  minutes, on `browser_close`, and when the conversation goes `done` or `gone`
  (`conversation-ended.ts`; `HAS_AGENT` names every status). Its requests carry
  the agent-origin headers with source `mcp-browser:<conversationId>` on every
  deploy behind the gateway (`http://<namespace>.localhost:9000` — its own
  build, main, another worktree) and on nothing else (a CDN, a public website).
  The session records each deploy it reached (`origins` in the status), and
  closing reverts THAT source's writes on each (`shared/revert.ts`) — never
  another conversation's or an e2e run's.
- **Closing drains first** (`bin/write-drain.ts`). A context close aborts its
  requests client-side only: a write already sent still lands, and if it lands
  after the revert it sticks. So the session tracks its non-GET requests to the
  deploys from the moment it opens; closing routes every new request to an
  abort (a debounced write-back firing mid-close included), waits for the
  tracked ones to get their response (≤ 10 s; past that a `drain-writes` host
  error names them and the revert runs anyway), then closes and reverts.
- **A host that dies** (SIGKILL, OOM) leaves `status.json` saying `ready` for a
  dead pid (`died`). Its sessions' writes are still in each target's ledger:
  the next `ensureHost` reverts every listed session before relaunching, and a
  conversation ending meanwhile reverts its own.
- **Drive admission** (`bin/host-drives.ts`). Every spec in `shared/tools.ts`
  declares a `cost`. A `drive` call (navigate, act, batch, javascript,
  screenshot, viewport) runs under one slot of the host-wide `e2e` pool — the
  pool every e2e script run takes — so agents' pages and scripts' browsers
  share one bound. Per call, not per session (a session lives 30 idle
  minutes). A `read` call (tabs, read_page, find, page text, console,
  network, attach, close) never queues. No op marker or op-log record per
  call; a call that waited ≥ 1 s says so in its result, and the status counts
  `drives` running and waiting.
- **Tab** — `t1`, `t2`, …; a call naming none acts on the last one used. Each
  records its console (incl. page errors and auto-dismissed dialogs) and network
  from the moment it opens, capped at 500 entries. At most 5 per session, 32
  sessions per host.

## Observability

- `agent-browser.status` (core) — the host's status file + pid liveness
  (`absent` / `running` / `exited` / `died` / `unreadable`), pushed on every
  rewrite by a file watcher on every backend.
- Health report → **Agent browser** row (`web/`): running or not, sessions,
  tabs, idle deadlines, calls driving / waiting for a slot, recent host-side
  failures (an idle close, a revert or a drain nobody was waiting on lands in
  the status's `errors`).
- Debug → Background activity → `mcp-browser.host`.
- **Recordings**: a page-changing call (`RECORDED_BROWSER_TOOLS`, owned by
  `debug/browser-recordings`) is recorded under the agent's tool call — the MCP
  context's `toolUseId`, which Claude Code sends in `_meta` — as one step whose
  frame is the tab's viewport once the page settled — loaded, first
  content painted, nothing `aria-busy`, ≤ 5 s — (`server/internal/record-call.ts`,
  through the host's own `browser_screenshot`, so the host is untouched). The
  conversation shows it under the call, like an e2e run's filmstrip.

## Targeting

`resolveTarget` (`target.ts`): conversation → `worktreePath` →
`resolveCheckoutDeploy` (the deploy registry the harness reads) →
`namespaceUrl`, sent with every call (`HostTarget`: `deploy` or `unbuilt`), so
a build made mid-session takes effect on the next call. A route (`/…`)
resolves against it, and is refused while the checkout is `unbuilt` — never
derive the origin from a name, which would drive main. An absolute http(s) URL
needs no build: an agent can open a public website, or main, before it has
built anything. `browser_attach` needs a build (a script drives one).

## Tools

Shaped after Claude-in-Chrome: `browser_tabs`, `browser_navigate`,
`browser_read_page` (`ariaSnapshot({ mode: "ai" })` — refs `eN`, resolved with
the `aria-ref=` selector), `browser_find`, `browser_get_page_text`,
`browser_act`, `browser_batch`, `browser_javascript`, `browser_screenshot`
(an MCP image block), `browser_console`, `browser_network`, `browser_viewport`,
`browser_attach` (below), `browser_close`.

## Script attach (`browser_attach` → `--attach`)

An e2e script can run INSIDE a session and leave its tab there, so an agent
continues from the step a script failed at instead of replaying it.
`browser_attach` (`bin/host-attach.ts`) binds the host's browser (`bindEndpoint`: Playwright's
`browser.bind()`, a local pipe, once per launch), opens a fresh tab parked at a
one-off marker URL, and returns a ticket (`core/`: endpoint, marker, tab,
origin, Playwright version). The harness's `withBrowser` decodes it,
`connectChromium`s, finds the tab by marker and drives it. Bound connections run
in Playwright's shared-browser mode — they see every context and leave them open
on disconnect — so the tab is the session's own, before and after.

Every page that appears in a session's context is adopted as a tab
(`context.on("page")`), so pages a script opens are visible too, and a tab's
requests reset the session's idle deadline, so a long script run is not closed
under it.

## Not yet

- Multi-session scripts under `--attach`.

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./singularity build` -->

## Plugin reference

- Description: The health report's Agent browser row: whether the machine's agent-browser host runs, its sessions (conversation, target, tabs) and when each closes if left idle, and a host that died without closing them — read from the agent-browser.status push value. Agent browser: MCP tools (browser_navigate, browser_read_page, browser_act, browser_batch, browser_screenshot, browser_console, …) forwarded to one detached host process per machine that owns the shared headless Chromium — an isolated session per conversation targeted at that conversation's own worktree build, tabs that stay open across calls and across backend restarts — plus the agent-browser.status value (host, sessions, tabs, deadlines) pushed from the host's status file.
- Web:
  - Contributes: `HealthReport.Row` "Agent browser" → `AgentBrowserDetail`
  - Uses:
    - `network/live.useLive`
    - `primitives/css/spacing.Stack`
    - `primitives/css/text.Text`
    - `primitives/data-view.DataView`
    - `primitives/data-view.defineDataView`
    - `primitives/data-view.FieldDef`
    - `primitives/live-state.foldResource`
    - `primitives/relative-time.useNow`
    - `shell/health-report.HealthReport`
- Server:
  - Contributes:
    - `trigger` "mcp-browser.conversation-ended"
    - `resource.declare` "agent-browser.status"
  - Uses:
    - `infra/deps.requestDep`
    - `infra/events.Trigger`
    - `infra/file-watcher.defineFileWatcher`
    - `infra/file-watcher.FileWatcher`
    - `infra/jobs.defineJob`
    - `infra/mcp.Mcp`
    - `infra/mcp.McpToolCallContext`
    - `infra/spawn/daemon.DaemonInstance`
    - `infra/spawn/daemon.defineDaemon`
    - `network/live.serveValue`
    - `tasks/tasks-core.conversationStatusChanged`
    - `tasks/tasks-core.getConversation`
  - Register:
    - `mcpTool('browser_tabs')`
    - `mcpTool('browser_navigate')`
    - `mcpTool('browser_read_page')`
    - `mcpTool('browser_find')`
    - `mcpTool('browser_get_page_text')`
    - `mcpTool('browser_act')`
    - `mcpTool('browser_batch')`
    - `mcpTool('browser_javascript')`
    - `mcpTool('browser_screenshot')`
    - `mcpTool('browser_console')`
    - `mcpTool('browser_network')`
    - `mcpTool('browser_viewport')`
    - `mcpTool('browser_attach')`
    - `mcpTool('browser_close')`
    - `defineJob('mcp-browser.conversation-ended')`
    - `defineDaemon('mcp-browser.host')`
    - `defineFileWatcher('mcp-browser.host-status')`
  - Resources: `agent-browser.status` (push, notified)
- Core:
  - Uses: `network/live.liveValue`
  - Exports (types):
    - `AgentBrowserHostError`
    - `AgentBrowserHostStatus`
    - `AgentBrowserSession`
    - `AgentBrowserStatus`
    - `AgentBrowserTab`
    - `AttachTicket`
  - Exports (values):
    - `AgentBrowserHostStatusSchema`
    - `agentBrowserStatus`
    - `AgentBrowserStatusSchema`
    - `attachMarker`
    - `decodeAttachTicket`
    - `encodeAttachTicket`
    - `MAX_HOST_ERRORS`
    - `MAX_SESSIONS`
    - `MAX_TABS`
- Cross-plugin:
  - Uses tokens: `ui/tokens/shape --spacing`
- Exemptions:
  - Exempts itself from: `boundaries/no-platform-api` — `server/internal/host-client.ts`, `shared/code-id.ts` (debt)

<!-- AUTOGENERATED:END -->
