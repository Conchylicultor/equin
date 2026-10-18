# Agent browser: land the script attach, drain writes before revert, CPU grant per drive

Track: wiki Mental model › Harness › Browsing (`block-5340a17b-…`). Sidequests
task-1792278879-fq5oal / -f5ydi7 / -nuy32t (already dropped) cover the same items.

> **Outcome (as built):** the attach landed on main from its own worktree while this was
> being planned (4d2b333885, 62d42d5137), so § 1 was dropped. The user chose to leave the
> harness's settle poll as is, so § 2's harness half was dropped as well. The drain stays
> local to the host (`bin/write-drain.ts`). The spec flag is `cost: "drive" | "read"`.
> `browser_attach` is `read`.

## Context

The persistent host (`bin/host.ts`, plan `2026-10-17-infra-agent-browser-persistent-host.md`)
is on main. Three gaps keep the track's exit criteria from being met:

1. **Attach is not on main.** The track page says it exists only uncommitted against
   the old `server/internal/host.ts`. That's out of date. Worktree
   att-1792266237-5sx9io has already rebased it onto the host: branch commit
   `3038f34710`, on top of `ac96a1c548`, plus a one-line prettier change. Main has not
   touched the browser plugin, the harness or `playwright-browser` since `ac96a1c548`,
   so the commit applies cleanly. Its conversation (conv-1792266237-5w95e6) still says
   `working`, but nothing has changed there since 2026-10-17 23:15Z.
2. **Revert races in-flight writes.** `closeSession` closes the context and reverts at
   once. A mutating request that was already sent can land after the revert, and its
   write then sticks.
3. **No CPU admission.** Driving the browser (navigate = an app boot, act, screenshot,
   JS) is Chromium work on the host that no pool accounts for. E2e scripts take one
   `e2e` pool slot (`withE2eGrant`, `infra/host/host-admission`).

Multi-session (A/B) scripts under `--attach` stay `[Later]`.

## Design

### 1. Bring the attach commit in

`git cherry-pick -n 3038f34710` (no commit; `./singularity push` commits), plus the
`host-attach.ts` prettier change. This adds `browser_attach` (ticket), `--attach` in
`withBrowser`, `bindEndpoint()` / page adoption in `bin/host-session.ts`,
`connectChromium`, the `core/` attach-ticket codec, and docs. Review it against the
merge-base, then build. The other worktree's branch then becomes redundant; the user
decides what happens to it. I don't touch it.

### 2. Drain writes before reverting: one primitive, exact, no polling

This one primitive replaces both the harness's ledger poll and the missing wait in the
host.

`drainWrites(context, { origin, timeoutMs })` in the `playwright-browser` deps barrel
(`plugins/infra/plugins/deps/plugins/playwright-browser/deps`), which both `bin/` and
`e2e/` may import:

1. **Track in-flight mutating requests.** The context records every request whose method
   is not GET/HEAD and whose URL is on `origin`. Tracking starts when the context is
   created, via `context.on("request" | "requestfinished" | "requestfailed")`. These are
   context-level events, so they also cover pages a script opened through `bind()`.
   Tracking runs from the context's creation, because a request sent before the drain
   started is exactly the in-flight one this has to catch. So the API is two-part:
   `const writes = trackWrites(context, origin)` at creation, then
   `await writes.drain(timeoutMs)` at close.
2. **`drain`:**
   - Install `context.route("**/*", r => r.abort("blockedbyclient"))`. Later routes win,
     so nothing new is sent. That includes a DataView debounce timer that fires
     mid-drain.
   - Await the in-flight set reaching empty. This is a promise resolved by the events,
     not a poll.
   - Bounded by `timeoutMs`. On timeout it returns `{ kind: "timeout", pending: [method url…] }`
     instead of hanging.

   Once a request has its response, the server's handler has run, so its ledger
   `record`/`noteComplete` has landed. Every write is therefore either never sent or
   finished before the revert.

**Host.** `getSession` calls `trackWrites(context, target.origin)` and stores it on
`Session`. `closeSession` runs `drain`, then `context.close()`, then
`revertSessionWrites`. On a timeout it does `recordHostError("drain-writes …")`, a
health-row error naming the pending requests, and reverts anyway. A stuck request must
not keep the user's data changed forever.

**Harness.** In `e2e-harness/e2e/browser.ts`, `withBrowser`'s teardown drains each
context it created before `browser.close()`, and stops calling `settleAgentWrites`.
That deletes `settleAgentWrites` and the poll loop in `agent-writes.ts`. The "ledger
read" use goes. `GET /api/agent-writes` stays as the inspection route; its docs stop
calling it the quiescence signal. Attach mode is unchanged: it skips the repair, and the
session's own close drains.

A drain timeout in the harness is a FAIL (`report` teardown failure), the same weight
as a failed revert.

### 3. CPU grant per driving call

- **Spec table.** `shared/tools.ts` specs gain a required `drives: boolean` (tsc rejects
  a spec that leaves it out). `true` for navigate, act, batch, javascript, screenshot and
  viewport. `false` for tabs, read_page, find, get_page_text, console, network, close and
  attach. The `false` tools read in-memory state or an already-rendered tree, and must not
  queue 20 s behind an e2e script.
- **Host `/call`.** This is in `bin/host-tools.ts` or wherever `/call` dispatches. It wraps
  a driving tool in `withE2eGrant({ lane: "background", max: 1 }, …)` from
  `@plugins/infra/plugins/host/plugins/host-admission/server` (bin may import `server`).
  It goes in the host, not the backend, because the host is the process spending the CPU,
  and a backend restart mid-call must not matter. Flock slots release when the holder
  dies.
- **Same pool as e2e scripts,** because the cost is the same, one Chromium driving
  pages: two drives or scripts at a time host-wide.
- **No op marker or op-log record per call.** A ~0.2 s call would flood the banner and
  the Ops Gantt. The wait itself goes in the tool result: a call that queued over 1 s says
  "waited N s for a browser slot", so a slow call explains itself. The health-row status
  keeps a counter of drives in progress and queued (`status.json` → `agent-browser.status`).
- A script attached via `--attach` already holds the slot through `./singularity run`'s
  e2e op. The host's tool calls during it are separate MCP calls and take their own slot,
  which is correct.

## Files

- `plugins/infra/plugins/deps/plugins/playwright-browser/deps/internal/` (new `drain-writes.ts`) + barrel
- `plugins/infra/plugins/mcp/plugins/browser/bin/host-session.ts` (track/drain on close), `bin/host-tools.ts` / `bin/host.ts` (grant), `shared/tools.ts` (`drives`), `core/internal/status.ts` (drive counts), `web/` health detail (show them), `CLAUDE.md` ("Not yet" section)
- `plugins/framework/plugins/tooling/plugins/e2e-harness/e2e/browser.ts`, `e2e/agent-writes.ts` (drop the poll)
- `plugins/infra/plugins/request-origin/plugins/agent-write-ledger/{CLAUDE.md,core,server}` (doc wording only)
- Bump `HOST_PROTOCOL` if the wire shape changes (status gains fields).

## Verification

- `./singularity build`, then with the browser_* tools on this worktree's build:
  - Run `browser_attach` → `./singularity run <e2e script> --attach <ticket>` → `browser_read_page`
    and confirm the script's tab is still there.
  - Click a DataView "Group by", then `browser_close` immediately. `GET /api/agent-writes`
    should be empty, and the grouping reverted on reload.
- Drain race repro: from `browser_javascript`, fire a slow mutating fetch (or one write
  plus a 300 ms debounce), close at once, and confirm the ledger is empty afterwards. Old
  code: the entry survives.
- Grant: run two e2e scripts in the background, then a `browser_navigate`. The result
  says it waited, and the health row shows the queue.
- Harness regression: `screenshot.ts --click "…"` on a DataView, and a plain e2e script.
  Both pass, and their writes are reverted.
- `./singularity test plugins/infra/plugins/mcp/plugins/browser plugins/infra/plugins/deps/plugins/playwright-browser`
  passes. Add a unit test for `drainWrites` against a local Bun.serve: a slow POST
  resolves the drain only after its response, a request sent after drain starts is
  aborted, and a hanging POST times out.
- Track page: tick the three items, update Status, and file the next main task
  (A/B scripts under `--attach`, or the user's call).
