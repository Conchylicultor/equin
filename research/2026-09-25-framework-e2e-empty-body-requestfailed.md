# The "failed" first log post is a successful 204 the e2e harness mislabels

## Context

Clean-install baseline run 1 (`research/2026-09-18-global-clean-install-baseline-run-1.md`, finding
12) recorded six `REQUESTFAILED: POST /api/logs/emit — net::ERR_ABORTED` on a freshly deployed app.
The report came from the screenshot harness (`e2e-harness/e2e/screenshot.ts`, through `capture.ts`'s
`requestfailed` listener), not from a person looking at DevTools.

### Diagnosis (measured, not inferred)

1. **It is not clean-install specific.** `screenshot.ts --url http://singularity.localhost:9000` on
   this machine prints the same six lines, every run.
2. **It is not teardown.** In both the VM log (`~/.singularity-clean-install/si-clean-20260918-021701/26-screenshot.log`)
   and the local repro, every `REQUESTFAILED` prints **before** `wrote …-before.png`. That rules out
   the explanation already written into several scripts ("the log-emit beacon is aborted on teardown").
   The browser is still open at that point.
3. **It happens only when the emit succeeds.** While main was under duress, the handler answered 429
   and the same run showed `429` console errors and no `ERR_ABORTED`.
4. **Root cause: Chromium, as seen through Playwright, fires `requestfailed … net::ERR_ABORTED` for a
   successful `fetch` whose response has an empty body.** Isolated repro (a node server and a blank page,
   no app code): `POST → 204` and `POST → 200 with an empty body` both show up as `requestfailed ERR_ABORTED`,
   while `POST → 200 {json}` shows up as `requestfinished`. The page's `await fetch()` resolves normally in
   all three cases. `emitLogs` is a void endpoint, so `implement()` answers `new Response(null, { status: 204 })`
   (`infra/endpoints/core/implement.ts:133`). The six lines are six successful flushes: one per
   channel (`live-state`, `build-btn`, `latency-ledger`, …) and per WS-open trigger.
5. **A real abort and this artifact can be told apart synchronously.** On the artifact,
   `req.timing().responseStart >= 0` and `await req.response()` returns the real status (204 / 200).
   On a genuine abort (`AbortController`, navigation, or a close while the request is in flight),
   `responseStart === -1` and `response()` is `null`.

So nothing in the app fails. The harness's notion of a "failed request" is wrong for **every void
endpoint** (every 204), not just log emits. Because of that, three scripts have given up on
`failedRequests` entirely, which also hides real failures.

## Plan — make `captured.failedRequests` true (e2e-harness)

This is a rung-1 fix: the harness stops misclassifying at the one place requests are classified,
instead of each script filtering the noise.

1. **`plugins/framework/plugins/tooling/plugins/e2e-harness/e2e/capture.ts`**: add and export
   `requestFailure(req: Request): string | null`. It returns the failure text for a request the browser
   genuinely never got an answer to. It returns `null` when `req.timing().responseStart >= 0`, meaning
   a response arrived and only the empty body's stream was cancelled. The docblock records the
   empty-body quirk and the repro above. The `requestfailed` listener pushes, and prints `REQUESTFAILED`,
   only when `requestFailure` returns non-null. Export it from the harness `e2e/index.ts` barrel.
2. **`plugins/release/e2e/release-boot-verify.ts`**: its own `requestfailed` listener goes through
   `requestFailure` (skip on `null`). Keep the existing `ERR_ABORTED` storm exclusion, since it still
   covers genuine navigation aborts, but correct its comment.
3. **`plugins/apps/plugins/pages/plugins/page-tree/e2e/row-actions-overflow.ts`** and
   **`plugins/primitives/plugins/row-actions/e2e/click-does-not-pin.ts`**: delete the incorrect
   "beacon aborted on teardown" comment and fold `captured.failedRequests` back into the
   clean-run assertion. If a run then shows a genuine abort, report it; do not re-exclude it.
   (The three `events/sources` scripts exclude `requestfailed` for genuine navigation aborts. That
   reason is true, so leave them as they are.)
4. **Docs**: in `e2e-harness/CLAUDE.md`, one short paragraph on what `failedRequests` means and why a
   204 is not in it. Close finding 12 in the clean-install baseline doc with a pointer to this file.

No app, endpoint or gateway change: switching void endpoints to JSON bodies to please a test tool
would be a workaround, not a fix.

## Separate finding: the 429 retry storm in `clientLog` (proposed, needs a yes)

The duress runs exposed a real client bug in
`plugins/primitives/plugins/log-channels/web/client-log.ts`. After a 429, the client is meant to
back off for 30 s (`BACKPRESSURE_RETRY_DELAY_MS`). Instead it re-POSTs every ~300 ms, because
`flush()` has three other entry points that ignore the backoff: the 250 ms debounce on every
new `clientLog` line, every `subscribeWsStatus` `open` (several sockets), and overlapping calls
(`flush` is not single-flight). One page load produced about 30 rejected POSTs in 5 s, each one a
browser-native `Failed to load resource: 429` console error. That is exactly the traffic the 429 is
supposed to shed.

Fix:
- Make `flush()` single-flight. A call made while a flush is running marks the running flush dirty
  and re-runs it once afterwards, so batches never interleave.
- Keep a `holdUntil` deadline. While it is in the future, the debounce and WS-open triggers are
  no-ops, and the retry timer is the only thing that fires. A WS `open` clears a plain
  failed-flush hold (the backend is back), but never a 429 hold (the duress latch is host-wide,
  and a reconnect says nothing about it).
- Tests: extend the existing client-log tests, using fake timers and a stubbed `fetchEndpoint`:
  after a 429, further `clientLog` calls and WS opens send nothing until the backoff elapses, and
  two concurrent flush triggers send one POST.

## Verification

- `./equin build`, then `screenshot.ts` (no target flag) on this worktree's deploy while the
  host is not under duress: no `REQUESTFAILED` lines, and the page's lines appear in
  `~/.singularity/worktrees/<wt>/logs/{live-state,latency-ledger}.jsonl` (proof the emits landed).
- Confirm genuine aborts are still caught: rerun the scratch repro (an aborted fetch plus a 204 fetch)
  through `requestFailure` and check the abort is reported and the 204 is not.
- Run `row-actions-overflow.ts`, `click-does-not-pin.ts` and `release-boot-verify.ts`, and check that
  they pass with `failedRequests` folded back in.
- If the retry-storm part is included: `./equin test plugins/primitives/plugins/log-channels`.
