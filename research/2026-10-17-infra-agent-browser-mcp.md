# Agent browser — a shared headless browser as MCP tools

Wiki track: Mental model › Harness › Browsing (`block-5340a17b-…`), design sub-page `block-305a94b7-…`.

## Context

Agents verify UI work two ways today, both flawed:

- **e2e scripts** (`e2e-harness`, `withBrowser`): isolated and targeted at the checkout's deploy, but
  batch-only — a failed step means relaunching Chromium, re-booting the app and replaying every step.
- **Claude-in-Chrome**: interactive (the page stays alive between tool calls) but it is the user's
  single real Chrome, on their screen, with their accounts, and hand-typed URLs drive main by mistake.

Goal: an interactive, headless, isolated browser — the iteration loop of Claude-in-Chrome with the
safety of the harness.

## Design

**Where it lives.** A new server plugin `plugins/infra/plugins/mcp/plugins/browser` contributing MCP
tools. MCP is served by the backend that launched the agent (`SINGULARITY_PARENT_HOST`, normally
main), so the browser lives in that one backend process: in practice ONE Chromium for every agent on
the machine, with no central-core change (central-core is off-limits without approval, and has no
playwright).

**Model: one browser, a session per conversation, live tabs.**

- Browser: `launchChromium(ready)` (playwright-browser kind; `readyNow(chromium)` +
  `requestDep(chromium)` exactly like `prototypes/thumbnails` — the backend never installs). Lazy,
  single-flight launch; `disconnected` clears all state; closed after 5 min with no session.
- Session: a `BrowserContext` per conversation id — own cookies/storage, viewport 1400×900, the
  harness's agent-origin headers (`agentOriginHeaders("mcp-browser")`, kept on the target origin only)
  so writes the drive makes are attributable. Closed after 10 min idle, and when the conversation goes
  `done` (Trigger on `conversationStatusChanged`, in-process job). On close the agent-write ledger is
  reverted on the target (same endpoint the harness calls), so a drive leaves no durable state.
- Tab: `t1`, `t2`, … inside the session; tools default to the last-used tab. Per tab: console ring
  buffer (all levels + page errors + auto-dismissed dialogs) and network ring buffer (method, url,
  status, failure), recorded from tab open. Max 5 tabs per session (oldest closed).

Idle deadlines are per-session `setTimeout`s reset on use — a deadline, not a polling loop.

**Targeting.** `conversationId → getConversation → worktreePath → resolveCheckoutDeploy(worktreePath)
→ namespaceUrl(ns)`. A route (`/agents/…`) resolves against that deploy; no deploy → loud error
("run ./singularity build"). An absolute `http(s)://` URL is accepted as the escape hatch and echoed in
every result, so the target is never implicit.

**Tools** (shaped like Claude-in-Chrome so agents' habits carry over):

| Tool | Claude-in-Chrome analogue |
|---|---|
| `browser_tabs` {action: list/new/close} | tabs_context / tabs_create / tabs_close |
| `browser_navigate` {url \| "back" \| "forward"} | navigate |
| `browser_read_page` {ref?, depth?} — `ariaSnapshot({mode:"ai"})` with `[ref=eN]` | read_page |
| `browser_find` {query} — snapshot lines matching, with refs | find |
| `browser_get_page_text` | get_page_text |
| `browser_act` {action: click/double_click/hover/fill/type/press/select/scroll/wait, ref \| selector \| coordinate, …} | computer / form_input |
| `browser_batch` {actions: [...]} — stops at the first failure | browser_batch |
| `browser_javascript` {code} | javascript_tool |
| `browser_screenshot` {fullPage?, ref?} — image content | computer screenshot |
| `browser_console` {pattern?, errorsOnly?, clear?} | read_console_messages |
| `browser_network` {pattern?, failedOnly?, clear?} | read_network_requests |
| `browser_viewport` {width, height, colorScheme?} | resize_window |
| `browser_close` {} — the whole session | — |

Every action result reports the tab's url/title after it and the console errors it caused.

**MCP image results.** `McpToolResult.content` widens to also allow `{type:"image", data, mimeType}`
(the SDK already supports it); `handle-mcp.ts` passes results through unchanged.

## Out of scope (next task)

- **Hybrid keep-mode**: an e2e script attaching to the conversation's session and leaving its tab open.
  Needs the browser reachable from another process (CDP endpoint) — its own design.
- Host CPU grant / op banner for interactive drives (an interactive session must not hold the E2E op).
- Coordinate-based vision clicking parity beyond `coordinate` on `browser_act`.

## Files

- `plugins/infra/plugins/mcp/server/internal/mcp.ts` — widen `McpToolResult`.
- `plugins/infra/plugins/mcp/plugins/browser/` — `package.json` (playwright), `server/index.ts`,
  `server/internal/{host,target,tools,snapshot}.ts`, `CLAUDE.md`.
- `CLAUDE.md` (root) — Driving the app: explore with the `browser_*` tools.

Reuse: `launchChromium` / `playwrightBrowser` (`infra/deps/plugins/playwright-browser/deps`), `chromium`
dep (`safe-fetch/browser-fetch/deps`), `readyNow` / `requestDep` (`infra/deps`), `resolveCheckoutDeploy`
(`infra/paths/core`), `namespaceUrl` (`infra/namespace/core`), `agentOriginHeaders`
(`infra/request-origin/core`), `revertAgentWrites` (`request-origin/agent-write-ledger/core`),
`getConversation` / `conversationStatusChanged` (`tasks-core/server`), `Trigger` (`infra/events/server`).

## Verification

1. `./singularity build` (checks incl. type-check / lint / boundaries).
2. Drive this worktree's own MCP endpoint (`POST http://<wt>.localhost:9000/api/mcp/<conv>`, JSON-RPC
   `tools/call`) — the tools resolve the conversation to this worktree's deploy: navigate `/`,
   read_page, act on a ref, console, screenshot (image block), batch, a second call reusing the same
   tab (no relaunch: timing), browser_close.
3. Confirm one Chromium process serves two sessions (`pgrep -fl headless_shell`) and is gone after
   the idle window.
