# Agent browser: e2e scripts attach to the conversation's session (`--attach`)

Wiki track: Mental model › Harness › Browsing (`block-5340a17b…`), design sub-page `block-305a94b7…`.
Follows `research/2026-10-17-infra-agent-browser-mcp.md` (v1: `plugins/infra/plugins/mcp/plugins/browser`).

## Context

v1 gave agents `browser_*` MCP tools over one shared headless Chromium in the MCP-serving backend,
a `BrowserContext` per conversation, tabs alive across calls. But an e2e script (`withBrowser`,
e2e-harness) still launches its own Chromium and kills it on exit. When a script fails at step N
the agent cannot look at that page with `browser_*`; it must replay everything interactively.
Exit criterion of the track: a script runs **inside the conversation's session** and leaves its tab
there, so the agent picks up at the failure point.

The hard part: the browser lives in the backend process, the script in its own `./singularity run`
process, and Playwright contexts are normally owned by the connection that made them.

## Key finding: Playwright 1.62 `browser.bind()`

`Browser.bind(title)` (public since 1.6x, the `playwright-cli` attach mechanism) serves an
already-launched browser on a local named pipe (unix socket). Connections to it run in
*shared-browser* mode (`BrowserDispatcher` with `isolateContexts: false`, `ignoreStopAndKill`):

- a connecting client sees **every** existing context and page (`browser.contexts()`, `context.pages()`);
- contexts/pages are **not** closed when that client disconnects;
- the client's `browser.close()` only closes its connection, never the browser.

So: the backend binds its shared browser; a script `chromium.connect(endpoint)`s, drives a page in
the conversation's own context, disconnects — the page stays, and the backend's own Playwright
objects keep seeing it (console, network, read_page all work on it).

CDP (`connectOverCDP`) and `launchServer` were rejected: CDP would put two Playwright clients on one
target's Fetch/route interception; `launchServer` isolates contexts per connection (the script's
context dies with it).

## Design

### Handoff: an attach ticket, issued by MCP

1. Agent calls new MCP tool **`browser_attach`** (optional `tab`; default: open a fresh tab).
   The backend ensures the session, binds the browser (once per launch), opens/marks the tab by
   navigating a fresh tab to `about:blank#attach-<nonce>`, and returns a **ticket** plus the
   exact flag to pass: `--attach <ticket>`.
2. Agent runs `./singularity run <script>.ts --attach <ticket>`.
3. The script drives that tab; on exit (pass **or** fail) it disconnects and prints
   `kept tab t3 in this conversation's browser session — continue with browser_read_page({ tab: "t3" })`.
4. Agent continues with `browser_*` on `t3`, exactly at the step that failed.

Ticket = base64url JSON, codec in the browser plugin's new `core/` barrel (`encodeAttachTicket` /
`decodeAttachTicket`, zod-parsed): `{ v: 1, endpoint, marker, tab, origin, playwright }`. No file,
nothing to clean up: a stale ticket (backend restarted, session closed, tab evicted) fails loudly
at connect / marker lookup with "call browser_attach again".

**Why a ticket, not `--keep` reading the pane's `SINGULARITY_CONVERSATION_ID`:** the harness would
need two ambient env reads (conversation id + `SINGULARITY_PARENT_HOST` to find the MCP backend),
exactly the inherited-channel shape `e2e-harness:target-not-env-derived` bans by prefix. The
ticket is per-invocation and explicit (like `--url`), the MCP side knows the conversation
authoritatively, and it costs the agent one tool call. (`--attach` implies keep.)

### Backend — `plugins/infra/plugins/mcp/plugins/browser/server/internal/host.ts`

- `bindEndpoint(): Promise<string>` — lazily `browser.bind("singularity-agent-browser")` once per
  launched browser; reset in the existing `disconnected` handler.
- `openTab` split into `adoptPage(session, page)` (the recorders: console / pageerror / dialog /
  network / close) + `openTab`. A `session.context.on("page")` listener adopts every page that
  appears in the context — so pages a script (or a popup) opens become tabs too. Dedupe by a
  page→tab map, so the backend's own `newPage` isn't adopted twice.
- Activity keeps the session alive: an adopted page's `request` event calls `touch(session)`, so a
  long script run (which makes no MCP call) isn't idle-closed mid-run. Same rule benefits a tab
  that is busy on its own.
- `tools.ts`: `browser_attach` tool (shape above), description says when to use it.
- New `core/index.ts` + `core/internal/attach-ticket.ts`: ticket schema + codec, shared with the
  harness.

### Harness — `plugins/framework/plugins/tooling/plugins/e2e-harness/e2e/browser.ts`

`withBrowser` reads `arg("attach")`. When present (attach mode):

- `assertDeployIdentity()` still first. Then refuse unless `isTargetOrigin(ticket.origin)`
  (`target.ts`): a ticket for another worktree's session must not be driven against this
  checkout's target. Refuse `--headed` with `--attach`.
- Refuse a Playwright version mismatch (`ticket.playwright` vs this checkout's resolved
  `playwright` — reuse `packageVersion`) with a message naming both: connect requires matching
  versions, and main's backend may lag a worktree's upgrade.
- **No** `ensureDepViaCli` / `launchChromium`: `chromium.connect(ticket.endpoint)` (chromium from
  `browser-fetch/deps`), with an `attachFailure` diagnostic like `launchFailure`.
- **No** start/end `repairAgentWrites` / `settleAgentWrites`: the session owns those writes, and
  its close (`closeSession` → `revertWrites`) already reverts the same ledger. Reverting at script
  start would wipe the agent's interactive state it is deliberately continuing from. Documented
  trade-off: the baseline is the session's, not a clean one.
- `session()` — first call returns the ticket's page (found by `marker` across
  `browser.contexts().flatMap(c => c.pages())`) and its context; applies `viewport`
  (`page.setViewportSize`) and `colorScheme` (`page.emulateMedia`); `trackContextNetwork(context)`
  and `capture(page)` as today. Headers/route stripping are already on the context (source
  `mcp-browser`). A **second** `session()` call throws "attach mode drives one session — run
  multi-session scripts without --attach" (32/313 scripts; v1 limitation, see below).
- Teardown (via `onBeforeFinish`, both paths): `browser.close()` (= disconnect only), then print the
  kept-tab line; `assertPageWasConsumed()` unchanged.

Every existing script gets `--attach` for free (incl. `screenshot.ts`), no per-script change.

### Docs

- `browser/CLAUDE.md`: replace "Not yet: keep-mode" with the attach model (bind, adoption,
  activity touch); `e2e-harness/CLAUDE.md`: the `--attach` flag and what it skips.
- Root `CLAUDE.md` › Driving the app: one line — "a failing script: `browser_attach`, rerun with
  `--attach <ticket>`, inspect the kept tab".
- Wiki track: tick the hybrid checkbox, update Status (after it works).

## Not in scope (v1)

- Multi-session scripts under `--attach` (would need extra contexts adopted as sub-sessions).
- Reverse direction (export a session's steps as a script).
- A per-drive host CPU grant for interactive tools (script runs already are ops).

## Risks

- `bind()` is new API — step 0 is a spike confirming, on 1.62.1: `connect(pipePath)` works from a
  separate bun process; a page opened/navigated by the script surfaces on the backend's context
  (`page` event, console/network recorders fire); disconnect leaves it open.
- Bound socket is local, user-owned (single instance per user, ADR) — any local process could
  attach, same as today's ability to read the user's files.
- `MAX_TABS` LRU eviction can drop a kept tab if the agent opens 5 more; message already says so.

## Verification

1. Spike (step 0) as a throwaway script under the scratchpad.
2. `./singularity build` (type-check, lint, boundaries, plugins-doc-in-sync).
3. Through this worktree's own MCP endpoint (`POST http://<wt>.localhost:9000/api/mcp/<conv>`,
   JSON-RPC `tools/call`, as in v1 verification): `browser_attach` → ticket.
4. Run a script that fails mid-flow (e.g. `screenshot.ts --path /agents --click "<missing>"`) with
   `--attach <ticket>`; confirm it prints the kept-tab line, exits non-zero.
5. `browser_read_page` / `browser_console` on that tab via the same endpoint: same URL and state
   the script stopped at; no relaunch (`pgrep -fl headless_shell` shows one Chromium).
6. Refusals: `--attach` + `--headed`; ticket with a foreign origin; a stale ticket after
   `browser_close`; a second `session()` call.

## As landed

Rebased onto the persistent host (`research/2026-10-17-infra-agent-browser-persistent-host.md`):
the backend half now lives in the detached host process — `bindEndpoint` / `adoptPage` in
`bin/host-session.ts`, the ticket issuer in `bin/host-attach.ts`, `browser_attach` in the shared
spec table (`shared/tools.ts`) and implemented in `bin/host-tools.ts`; the backend just forwards it.
The bound pipe is the host's, so a ticket survives a backend restart. In attach mode the script's
requests carry the session's `mcp-browser:<conversationId>` source (the context's headers), so its
writes revert with the session, not with the harness's `e2e:*` scope.
