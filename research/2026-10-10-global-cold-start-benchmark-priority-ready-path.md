# Cold start: benchmark, priority, ready path

Track: "Cold start performance" wiki page (block-31faa75d-f93e-469e-99dd-cdc706059377). Evidence on its sub-page block-a1810a7d-1ef1-4846-b531-b31dbf61ed0c. Benchmark numbers and status live on the track page, not here.

## Context

Opening a worktree whose server was stopped for idleness shows only the background for ~5 s: ~3.7 s of server start (2.3 s loading code, 1.1 s of blocking startup work) and ~1.3 s of boot snapshot. This session does the three small items: a repeatable measurement, starting a server a browser waits on at normal priority, and trimming the blocking startup work. Bundling and lazy plugin loading come later, sized by this benchmark.

Exit criteria (confirmed 2026-10-09): page request to first screen with data under 1 s on a calm host, under 2 s with 3 builds running, without any browser-side copy of the data.

## 1. Benchmark

Per iteration: stop the worktree's server, load a page in a fresh browser, record page request → first screen with data, split into gateway spawn→ready, server phases (code loading, register, each `onReadyBlocking` hook) and the snapshot (per entry: memory / persisted / loader).

Reused:
- e2e harness (`withBrowser`, target resolution, `report`): `plugins/framework/plugins/tooling/plugins/e2e-harness/e2e`
- client boot spans: `plugins/primitives/plugins/perfs/plugins/boot-trace` (`boot-snapshot`, `res:<key>`, `set-state`)
- server phase spans: `GET /api/debug/profiling/boot` (server-core profiler)
- gateway boot stamps, already POSTed to the server: `plugins/debug/plugins/boot-monitor` gateway-report

Added:
- gateway `POST /gateway/worktrees/<name>/stop` → existing `Worktree.Stop` (no route today)
- a "first data render" instant in the boot trace; boot spans also emitted as User Timing (`performance.measure`) so a script reads them with no global
- the gateway report in the profiling boot response
- `plugins/debug/plugins/profiling/plugins/cold-start/e2e/cold-start.ts`: `--iterations` (5), `--path` (`/agents`), `--busy N` (N background-priority CPU spinners standing in for builds); prints min / median / p95 per phase plus load average

## 2. Priority

Today every worktree server spawns under `taskpolicy -b` and is lifted only once ready, or after the 15–90 s adaptive timeout (`gateway/worktree.go` `startBackend` / `promoteBackend`).

Change: `Ensure` learns why it starts the server. A browser opening the worktree — a document navigation (`Sec-Fetch-Dest: document`) or the app's WebSocket upgrade (`Sec-Fetch-Mode: websocket` with an `Origin`) — spawns without demotion. Everything else keeps it: non-browser API calls (agents' MCP tools, scripts, other servers) and deploys (`proxy.go:306`). A browser request joining a background start promotes it at once (under the lock; `bk.demoted` is mutated unlocked today).

Agents' Playwright browsers count as browsers (decided 2026-10-09): same headers, already bounded by the e2e op's host CPU grant, and latency-sensitive too. The server's own heavy children stay demoted via `spawn-priority`.

Start on page load (decided 2026-10-11). The first cold run showed the server asked to start only ~4.5 s after the page request: `handleStatic` serves the SPA shell without `Ensure`, so the start waits for the app's first `/api` or `/ws` request, after its code has loaded. A document request for the shell (`Sec-Fetch-Dest: document`) now also starts the backend asynchronously, with the browser reason, never delaying the static response. Assets don't trigger a start.

## 3. Ready path

"Ready" keeps meaning fully installed; nothing moves after ready (a write before the change-feed triggers exist would lose its notification).

The change-feed already skips its rebuild per table by signature (`triggers.ts:765`, `planRebuild`); a typical boot logs "up to date (126 tables)" 854 ms after the step's first line. The cost is reading the catalog: `singleColumnPk` per table in a sequential loop (`triggers.ts:747`), plus `tableColumns` per routed table — ~130 round trips through PgBouncer.

Order: add a profiler span per sub-step of each blocking hook, measure, then fix.
- change-feed (670 ms): one batched catalog query for every table's PK and columns.
- database (247 ms), config_v2 (482 ms), jobs (180 ms): fix chosen from the sub-step spans.

## Verification

- `./singularity build`, then `cold-start.ts` calm and `--busy 3`, before and after each step; numbers on the track page.
- change-feed: existing `triggers` tests unchanged (same plan for the same schema).
- gateway: `go test ./...` in `gateway/` for the stop route and the start-reason priority.
- gateway changes go live through `./singularity start` (user-approved).
