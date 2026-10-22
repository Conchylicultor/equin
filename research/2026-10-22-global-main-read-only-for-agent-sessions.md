# Main is read-only for agent sessions

**Status: implemented (2026-10-22), not yet pushed.** Resolved questions: the
predicate is `isMain()` alone (no release-instance handling); no escape hatch;
`app-usage/flush` and `usage-rank/record` stay gated. Deviations from the design
below are listed in *Implementation notes* at the end.

## Context

An agent's headless browser (`infra/mcp/browser`) and the e2e harness
(`e2e-harness` `withBrowser` / `agentFetch`) may open **main**
(`singularity.localhost:9000`). That is useful: prototypes are only served by main,
the bugs the user reports are on main, and an agent with no build yet has only
main to look at. But every click there can write to the user's real data, and
today the protection is **write, then undo at close**:

- the agent-write ledger (`request-origin/agent-write-ledger`) only covers
  file-backed domains (config_v2, prototype picks/status) — DB writes (tasks,
  pages, attempts…) are never undone;
- the user lives with the agent's changes until the session closes;
- a write that lands after the revert sticks — `closeSession` drains in-flight
  non-GETs for 10 s first, and when telemetry POSTs don't answer it raises the
  `drain-writes … still unanswered` health warning (the false alarm that
  prompted this).

Intended outcome: on main, an agent-origin request **cannot write** — it is
refused before the handler runs — except endpoints that *declare* themselves
safe for agents (telemetry). Agents keep full read access to main. Nothing
on main ever needs reverting, and the drain stops waiting on telemetry.

## Design

### 1. One declaration on the endpoint: `agentWrite`

`defineEndpoint` (`plugins/infra/plugins/endpoints/core/define-endpoint.ts`)
gains an optional field, carried onto the contract:

```ts
agentWrite?: "telemetry"   // safe for an agent session to send anywhere
```

Absent = a normal write (the default, so a new endpoint is protected without
anyone remembering to opt in). GET/HEAD/OPTIONS are never gated. A closed
union, not a boolean, so the reason is stated and grep-able; a future arm
(e.g. `"agent-control"`) is a type change, not a new flag.

Marked `"telemetry"` (each verified to write only observability data):
`POST /api/logs/emit`, `POST /api/latency-ledger/client`,
`POST /api/slow-ops/client`, `POST /api/boot-traces`, `POST /api/reports`
(error reports). To audit before marking: `POST /api/app-usage/flush`,
`POST /api/usage-rank/record` — they feed the user's own rankings/usage, so
an agent's activity polluting them arguably *is* a write; default is to leave
them gated.

The revert route `POST /api/agent-writes/revert` must stay callable (start-of-run
repair, close-time revert, legacy entries) — it only ever undoes agent writes.
Mark it with a second arm, `"agent-control"`.

### 2. The gate: in `endpointHandler`, the one decode-and-answer place

`plugins/infra/plugins/endpoints/core/implement.ts` `endpointHandler` already
holds the endpoint definition and runs per-route gates (concurrency, dedupe).
Add one more, built once at registration:

```
if method ∉ SAFE && !endpoint.agentWrite && isProtectedDeploy():
  per request: if originOf(req) is agent → 403 AgentWriteRefused
```

- `originOf` from `@plugins/infra/plugins/request-origin/core` (already the
  single reading of the headers).
- `isProtectedDeploy()` = `isMain()` from
  `@plugins/infra/plugins/runtime-identity/core` — computed once, so worktree
  backends pay nothing.
- The 403 body is a typed, explanatory message (`"main is read-only for agent
  sessions — reproduce on your own build (./singularity build)"`), so the
  agent reading the failed request, console or toast learns why and where to
  go. 403 is below the ≥500 crash-report threshold, so it files no report.

Because every route goes through `implement` / `implementMachine`, this covers
the whole HTTP surface. Exploration found no raw non-GET `httpRoutes` keys and
no mutating WebSocket messages (`/ws/notifications` and `/ws/logs` accept only
subscribe ops). To keep that true, add a check: every non-GET key in a
plugin's `httpRoutes` must map to a handler built by `implement` (tag the
returned handler; the check reads the registry) — otherwise a future raw route
would silently bypass the gate.

### 3. The drain skips telemetry, from the same declaration

`bin/write-drain.ts` can't see endpoint definitions (it watches Playwright
requests). So the client stamps it: `fetchEndpoint`
(`plugins/infra/plugins/endpoints/web/internal/fetch-endpoint.ts`) adds
`x-singularity-agent-write: telemetry` when the endpoint declares it, and
`trackWrites` ignores requests carrying it. One declaration, two derived
readers; the header is advisory only (the server gate reads the definition,
never the header). This alone removes today's false alarm, on main *and* on
worktrees.

### 4. What changes for agents and the ledger

- On main: a click that would write gets a 403 and the UI's normal error
  path (optimistic overlays roll back). Reads, navigation, screenshots,
  prototype variants via `?pane=…&accent=…` (already the documented way —
  `prototypes/CLAUDE.md` "Never change the user's picks") all work.
- On worktree deploys: unchanged — writes allowed, ledger + revert on close.
- e2e scripts run with `--url <main>` that click writes will fail loudly
  instead of mutating main. That is the intent; scripts that need writes
  target the agent's build.
- Docs: `infra/mcp/browser/CLAUDE.md`, `request-origin/CLAUDE.md`,
  `agent-write-ledger/CLAUDE.md`, `e2e-harness/CLAUDE.md` and the root
  `CLAUDE.md` "Driving the app" section state that main is read-only for
  agent sessions.

## Open questions

1. **Released installs.** `isMain()` is false for a compiled release backend
   (runs under the composition's name). Does an agent session ever reach a
   release's live instance? If so, the predicate becomes "this is the user's
   live instance" (main *or* the release namespace), not `isMain()`.
2. **Escape hatch?** Proposed: none. If the user wants an agent to act on main
   it should be the user's own click, not an agent's. Alternative: a per-session
   opt-in the user grants explicitly — more surface, deferred until needed.
3. `app-usage/flush` and `usage-rank/record`: gated (default) or telemetry?

## Critical files

- `plugins/infra/plugins/endpoints/core/define-endpoint.ts` — `agentWrite` option + contract field
- `plugins/infra/plugins/endpoints/core/implement.ts` — the gate
- `plugins/infra/plugins/endpoints/web/internal/fetch-endpoint.ts` — the advisory header
- `plugins/infra/plugins/request-origin/core` — header name constant
- `plugins/infra/plugins/mcp/plugins/browser/bin/write-drain.ts` — skip stamped requests
- Telemetry endpoint definitions: `primitives/log-channels/core/endpoints.ts`,
  `debug/latency-ledger/core/internal/endpoints.ts`, `debug/slow-ops/shared/endpoints.ts`,
  `debug/boot-profile/shared/endpoints.ts`, `reports/shared/endpoints.ts`,
  `request-origin/plugins/agent-write-ledger/core` (revert → `"agent-control"`)
- New check under `endpoints/check/` — non-GET routes must be `implement`-built

## Verification

- Unit (`./singularity test plugins/infra/plugins/endpoints`): gate refuses a
  non-GET with agent headers when main, passes without headers, passes on a
  non-main namespace, passes `agentWrite` endpoints, never touches GET.
- `write-drain` test: a stamped request is not tracked.
- On a build of this worktree the gate is inert (not main), so verify on main
  semantics with the unit test plus a gate override in the test; after push,
  drive main with `browser_*`: change a DataView grouping → 403 and the
  grouping stays as it was; `browser_close` → no `drain-writes` row in the
  health report.

## Implementation notes

- **The "every write route is implement-built" invariant is a type, not a
  check.** server-core's `HttpRoutes<H>` (template-literal index signatures)
  types every server / machine barrel's `httpRoutes`: a `POST|PUT|PATCH|DELETE`
  key takes only `H & EndpointHttpHandler`, a brand only `infra/endpoints`
  mints. tsc found thirteen raw write routes (browser proxy POST, deploy analytics
  collect, worktree-cleanup deletes, attachments upload / delete / hold, MCP,
  two events-test harnesses, three events-test machine harnesses); each now goes
  through `rawEndpointHandler(endpoint, handler)` / `machineHandler(endpoint,
  handler)`, which runs the gate. `central/` routes are untyped by it and never
  gated (central is not main's backend).
- **No report storm.** A refusal is `403 { reason: "agent-write-refused" }`;
  `fetchEndpoint` throws `EndpointAgentWriteRefusedError`. Besides the ≥ 500 /
  validation-400 endpoint-error filter, two collectors would have filed one
  report per refused click and now skip it: the crash collector's
  `unhandledrejection` (a `void fetchEndpoint` write — e.g. the
  `createNotification` the "Request failed" toast posts, itself refused) and the
  optimistic-rejection collector (a 403 is a permanent rejection; it still
  toasts, with `agentWriteRefused` on the sink body).
- **`agentWrite` on a GET** is a tsc error (and a boot throw).
- **Known limits, accepted:** unmarked clients (raw `curl`, page JS overriding
  the headers) are users to the gate; the advisory header can be forged by a
  page, which only shortens the drain.
